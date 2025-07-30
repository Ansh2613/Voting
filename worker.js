// Define your GitHub repository details and file paths
const REPO_OWNER = 'minecraft2613';
const REPO_NAME = 'Election';
const BRANCH = 'main'; // Or 'master', depending on your default branch

// Define paths to your JSON data files in the GitHub repository
// IMPORTANT: Paths are now set to the root of the repository
const CANDIDATES_PATH = 'candidates.json';
const VOTES_PATH = 'votes.json';
const VOTING_IDS_PATH = 'voting_ids.json'; // This file now contains objects
const USED_VOTING_IDS_PATH = 'used_voting_ids.json';

// Define a User-Agent string for GitHub API requests
const USER_AGENT = 'Cloudflare-Worker-MinecraftVotingApp/1.0';

/**
 * Helper function to create CORS headers.
 * Access-Control-Allow-Origin is set to your specific frontend origin.
 * This is crucial for allowing your GitHub Pages frontend to make requests to this Worker.
 * @returns {Headers} CORS headers
 */
function getCorsHeaders() {
    return {
        'Access-Control-Allow-Origin': 'https://minecraft2613.github.io', // Your GitHub Pages frontend URL
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // Explicitly allow GET, POST, and OPTIONS
        'Access-Control-Allow-Headers': 'Content-Type', // Explicitly allow Content-Type header
        'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
    };
}

/**
 * Fetches file content from GitHub.
 * It decodes the base64 content and parses it as JSON.
 * Includes error handling for 404 (file not found) and other API errors.
 * @param {string} filePath - The path to the file in the repository (e.g., 'candidates.json').
 * @param {string} token - GitHub Personal Access Token for authentication.
 * @returns {Promise<{content: any, sha: string}|null>} - File content (parsed JSON) and its SHA, or null on error.
 */
async function fetchGitHubFile(filePath, token) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}?ref=${BRANCH}`;
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': USER_AGENT
            }
        });

        if (response.status === 404) {
            console.warn(`File not found on GitHub: ${filePath}. Returning empty content.`);
            return { content: [], sha: null };
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`GitHub API Error fetching ${filePath}: ${response.status} - ${errorText}`);
            throw new Error(`Failed to fetch file from GitHub: ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();
        let content;
        try {
            content = JSON.parse(atob(data.content));
        } catch (parseError) {
            console.error(`Error parsing content for ${filePath}:`, parseError);
            console.error('Raw base64 content:', data.content);
            throw new Error(`Failed to parse file content for ${filePath}: ${parseError.message}`);
        }
        return { content, sha: data.sha };
    } catch (error) {
        console.error(`Network or parsing error fetching ${filePath}:`, error);
        throw error;
    }
}

/**
 * Updates file content on GitHub.
 * This function uses optimistic concurrency control with SHA to prevent race conditions.
 * @param {string} filePath - The path to the file in the repository.
 * @param {any} newContent - The new content to write (will be stringified to JSON).
 * @param {string|null} sha - The SHA of the file's current version for optimistic concurrency.
 * Pass null if creating a new file.
 * @param {string} token - GitHub Personal Access Token.
 * @param {string} commitMessage - The commit message for the GitHub commit.
 * @returns {Promise<boolean>} - True if successful, false otherwise.
 */
async function updateGitHubFile(filePath, newContent, sha, token, commitMessage) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`;
    const contentBase64 = btoa(JSON.stringify(newContent, null, 2));

    const body = {
        message: commitMessage,
        content: contentBase64,
        branch: BRANCH
    };

    if (sha) {
        body.sha = sha;
    }

    try {
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': USER_AGENT
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json();
            if (response.status === 409 && errorData.message.includes('sha mismatch')) {
                throw new Error('sha mismatch: File has been updated by another process.');
            }
            console.error(`GitHub API Error updating ${filePath}: ${response.status} - ${JSON.stringify(errorData)}`);
            throw new Error(`Failed to update file on GitHub: ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        return true;
    } catch (error) {
        console.error(`Network or API error updating ${filePath}:`, error);
        throw error;
    }
}

// Export default object for ES Module Worker syntax
export default {
    /**
     * Handles incoming requests to the Cloudflare Worker.
     * @param {Request} request - The incoming request object.
     * @param {object} env - The environment variables for the Worker.
     * @param {ExecutionContext} ctx - The context object (e.g., for event.waitUntil).
     * @returns {Promise<Response>} - The response to the request.
     */
    async fetch(request, env, ctx) {
        // Log the entire env object for debugging
        console.log('Environment object (env):', env);

        const url = new URL(request.url);
        const path = url.pathname;
        
        // IMPORTANT: GITHUB_TOKEN_VAR must be set as a secret in your Cloudflare Worker settings.
        // In your Cloudflare Worker dashboard, go to 'Settings' -> 'Variables' -> 'Add variable'.
        // Variable name: GITHUB_TOKEN_VAR, Value: your GitHub Personal Access Token.
        // In ES Module syntax, 'env' should always be defined if variables are set.
        const GITHUB_TOKEN = env.GITHUB_TOKEN_VAR; 

        // Log the Origin header for debugging CORS issues
        console.log(`Incoming request Origin: ${request.headers.get('Origin')}`);
        console.log(`Request Method: ${request.method}`);
        console.log(`Request Path: ${path}`);

        // Handle OPTIONS preflight requests for CORS
        if (request.method === 'OPTIONS') {
            console.log('Handling OPTIONS preflight request.');
            return new Response(null, {
                status: 204, // No content needed for preflight success
                headers: getCorsHeaders(), // Apply CORS headers
            });
        }

        // Early check for the GitHub token configuration
        // In ES Module, if env.GITHUB_TOKEN_VAR is undefined, it means the secret wasn't injected.
        if (!GITHUB_TOKEN) {
            console.error('SERVER ERROR: GITHUB_TOKEN_VAR is not configured in Cloudflare Worker secrets.');
            return new Response('GitHub token is not configured in Cloudflare Worker secrets.', { status: 500, headers: getCorsHeaders() });
        }

        // Process API requests
        if (path.startsWith('/api/')) {
            const apiPath = path.substring(5);
            let responseBody;
            let statusCode = 200;
            let contentType = 'application/json';

            try {
                switch (apiPath) {
                    case 'candidates':
                        if (request.method === 'GET') {
                            const { content } = await fetchGitHubFile(CANDIDATES_PATH, GITHUB_TOKEN) || { content: [] };
                            responseBody = content;
                        } else {
                            statusCode = 405;
                            responseBody = { success: false, message: 'Method Not Allowed' };
                        }
                        break;

                    case 'votes':
                        if (request.method === 'GET') {
                            const { content } = await fetchGitHubFile(VOTES_PATH, GITHUB_TOKEN) || { content: [] };
                            responseBody = content;
                        } else {
                            statusCode = 405;
                            responseBody = { success: false, message: 'Method Not Allowed' };
                        }
                        break;

                    case 'voting-ids':
                        if (request.method === 'GET') {
                            const { content } = await fetchGitHubFile(VOTING_IDS_PATH, GITHUB_TOKEN) || { content: [] };
                            responseBody = content;
                        } else {
                            statusCode = 405;
                            responseBody = { success: false, message: 'Method Not Allowed' };
                        }
                        break;

                    case 'used-voting-ids':
                        if (request.method === 'GET') {
                            const { content } = await fetchGitHubFile(USED_VOTING_IDS_PATH, GITHUB_TOKEN) || { content: [] };
                            responseBody = content;
                        } else {
                            statusCode = 405;
                            responseBody = { success: false, message: 'Method Not Allowed' };
                        }
                        break;

                    case 'check-voting-id':
                        if (request.method === 'POST') {
                            const { votingId } = await request.json();
                            if (!votingId) {
                                responseBody = { success: false, message: 'Voting ID is required.' };
                                statusCode = 400;
                            } else {
                                const { content: validIdObjects } = await fetchGitHubFile(VOTING_IDS_PATH, GITHUB_TOKEN) || { content: [] };
                                const { content: usedIds } = await fetchGitHubFile(USED_VOTING_IDS_PATH, GITHUB_TOKEN) || { content: [] };

                                const foundIdObject = validIdObjects.find(item => item.id === votingId);
                                const isValid = !!foundIdObject;
                                const isUsed = usedIds.includes(votingId);

                                if (!isValid) {
                                    responseBody = { success: false, message: 'Invalid Voting ID.' };
                                    statusCode = 401;
                                } else {
                                    responseBody = {
                                        success: true,
                                        valid: true,
                                        used: isUsed,
                                        message: 'Voting ID accepted.',
                                        playerName: foundIdObject.playerName,
                                        gameEdition: foundIdObject.gameEdition
                                    };
                                    if (isUsed) {
                                        responseBody.message = 'Voting ID has already been used.';
                                    }
                                }
                            }
                        } else if (request.method === 'GET') { // Added GET for check-voting-id if needed, though POST is primary
                            const votingId = url.searchParams.get('votingId');
                            if (!votingId) {
                                responseBody = { success: false, message: 'Voting ID is required.' };
                                statusCode = 400;
                            } else {
                                const { content: validIdObjects } = await fetchGitHubFile(VOTING_IDS_PATH, GITHUB_TOKEN) || { content: [] };
                                const { content: usedIds } = await fetchGitHubFile(USED_VOTING_IDS_PATH, GITHUB_TOKEN) || { content: [] };

                                const foundIdObject = validIdObjects.find(item => item.id === votingId);
                                const isValid = !!foundIdObject;
                                const isUsed = usedIds.includes(votingId);

                                if (!isValid) {
                                    responseBody = { success: false, message: 'Invalid Voting ID.' };
                                    statusCode = 401;
                                } else {
                                    responseBody = {
                                        success: true,
                                        valid: true,
                                        used: isUsed,
                                        message: 'Voting ID status retrieved.',
                                        playerName: foundIdObject.playerName,
                                        gameEdition: foundIdObject.gameEdition
                                    };
                                }
                            }
                        } else {
                            statusCode = 405;
                            responseBody = { success: false, message: 'Method Not Allowed' };
                        }
                        break;

                    case 'register-candidate':
                        if (request.method === 'POST') {
                            const newCandidate = await request.json();
                            if (!newCandidate.partyName || !newCandidate.candidateName || !newCandidate.password) {
                                responseBody = { success: false, message: 'Missing required candidate fields (partyName, candidateName, password).' };
                                statusCode = 400;
                            } else {
                                const MAX_RETRIES = 3;
                                let registrationSuccess = false;
                                for (let i = 0; i < MAX_RETRIES; i++) {
                                    try {
                                        let candidatesData = await fetchGitHubFile(CANDIDATES_PATH, GITHUB_TOKEN);
                                        let candidates = candidatesData ? candidatesData.content : [];
                                        let sha = candidatesData ? candidatesData.sha : null;

                                        if (candidates.some(c => c.partyName.toLowerCase() === newCandidate.partyName.toLowerCase())) {
                                            responseBody = { success: false, message: 'A party with this name already exists.' };
                                            statusCode = 409;
                                            registrationSuccess = true;
                                            break;
                                        }

                                        candidates.push(newCandidate);
                                        const success = await updateGitHubFile(CANDIDATES_PATH, candidates, sha, GITHUB_TOKEN, `Add new candidate: ${newCandidate.candidateName}`);
                                        if (success) {
                                            responseBody = { success: true, message: 'Candidate registered successfully.' };
                                            registrationSuccess = true;
                                            break;
                                        }
                                    } catch (e) {
                                        console.warn(`Retry ${i + 1} for updating candidates.json:`, e.message);
                                        if (!e.message.includes('sha mismatch')) {
                                            throw e;
                                        }
                                        await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
                                    }
                                }
                                if (!registrationSuccess) {
                                    responseBody = { success: false, message: 'Failed to register candidate after multiple retries due to concurrent updates.' };
                                    statusCode = 500;
                                }
                            }
                        } else {
                            statusCode = 405;
                            responseBody = { success: false, message: 'Method Not Allowed' };
                        }
                        break;

                    case 'submit-vote':
                        if (request.method === 'POST') {
                            const voteData = await request.json();
                            const { votingId, party } = voteData;

                            if (!votingId || !party) {
                                responseBody = { success: false, message: 'Missing voting ID or party for vote submission.' };
                                statusCode = 400;
                            } else {
                                const MAX_RETRIES = 3;
                                let voteSubmissionSuccess = false;
                                for (let i = 0; i < MAX_RETRIES; i++) {
                                    try {
                                        const { content: validIdObjects } = await fetchGitHubFile(VOTING_IDS_PATH, GITHUB_TOKEN) || { content: [] };
                                        const foundIdObject = validIdObjects.find(item => item.id === votingId);

                                        if (!foundIdObject) {
                                            responseBody = { success: false, message: 'Invalid Voting ID provided for vote submission.' };
                                            statusCode = 401;
                                            voteSubmissionSuccess = true;
                                            break;
                                        }

                                        let usedIdsData = await fetchGitHubFile(USED_VOTING_IDS_PATH, GITHUB_TOKEN);
                                        let usedIds = usedIdsData ? usedIdsData.content : [];
                                        let usedIdsSha = usedIdsData ? usedIdsData.sha : null;

                                        if (usedIds.includes(votingId)) {
                                            responseBody = { success: true, message: 'This Voting ID has already been used to vote.' };
                                            voteSubmissionSuccess = true;
                                            break;
                                        }

                                        let votesFile = await fetchGitHubFile(VOTES_PATH, GITHUB_TOKEN);
                                        let currentVotes = votesFile ? votesFile.content : [];
                                        let votesSha = votesFile ? votesFile.sha : null;

                                        const finalVoteRecord = {
                                            votingId: votingId,
                                            party: party,
                                            minecraftName: foundIdObject.playerName,
                                            gameEdition: foundIdObject.gameEdition,
                                            realName: voteData.realName || '',
                                            discordInsta: voteData.discordInsta || '',
                                            timestamp: new Date().toISOString()
                                        };

                                        currentVotes.push(finalVoteRecord);
                                        usedIds.push(votingId);

                                        const votesUpdated = await updateGitHubFile(VOTES_PATH, currentVotes, votesSha, GITHUB_TOKEN, `Add vote for ${party} by ${votingId}`);
                                        if (!votesUpdated) throw new Error('Failed to update votes.json');

                                        const usedIdsUpdated = await updateGitHubFile(USED_VOTING_IDS_PATH, usedIds, usedIdsSha, GITHUB_TOKEN, `Mark voting ID ${votingId} as used`);
                                        if (!usedIdsUpdated) throw new Error('Failed to update used_voting_ids.json');

                                        responseBody = { success: true, message: 'Vote submitted successfully.' };
                                        voteSubmissionSuccess = true;
                                        break;

                                    } catch (e) {
                                        console.warn(`Retry ${i + 1} for vote submission:`, e.message);
                                        if (!e.message.includes('sha mismatch')) {
                                            throw e;
                                        }
                                        await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
                                    }
                                }
                                if (!voteSubmissionSuccess) {
                                    responseBody = { success: false, message: 'Failed to submit vote after multiple retries due to concurrent updates.' };
                                    statusCode = 500;
                                }
                            }
                        } else {
                            statusCode = 405;
                            responseBody = { success: false, message: 'Method Not Allowed' };
                        }
                        break;

                    default:
                        responseBody = { success: false, message: 'Not Found' };
                        statusCode = 404;
                }
            } catch (error) {
                console.error('API Handler caught unhandled error:', error);
                responseBody = { success: false, message: `Internal Server Error: ${error.message || 'Unknown error'}` };
                statusCode = 500;
            }

            // Apply CORS headers to all API responses
            return new Response(JSON.stringify(responseBody), {
                status: statusCode,
                headers: {
                    'Content-Type': contentType,
                    ...getCorsHeaders(),
                },
            });
        }

        // Default response for non-API paths
        return new Response('Not Found', { status: 404, headers: getCorsHeaders() });
    }
};
