const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { Octokit } = require('@octokit/rest');
require('dotenv').config({ override: true });

const app = express();
const port = process.env.PORT || 3000;

// Use GH_PAT to avoid Codespaces overriding GITHUB_TOKEN
const GITHUB_TOKEN = process.env.GH_PAT || process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.GITHUB_REPO;
const OWNER_PIN = process.env.OWNER_PIN;

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
    console.error('Error: GH_PAT (or GITHUB_TOKEN), GITHUB_OWNER, and GITHUB_REPO must be defined in .env');
    process.exit(1);
}

// Serve static files
app.use(express.static('public'));
app.use(express.json()); // For parsing application/json

const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// WebSocket setup
const wss = new WebSocketServer({ server });

// GitHub setup
const octokit = new Octokit({
  auth: GITHUB_TOKEN
});

const README_PATH = 'README.md';
const ALL_NUMBERS_PATH = 'all.json';

// State management
let currentNumbers = [];
let allNumbers = []; // Store ALL computed numbers
let count = 0;
let a = 0n; // Using BigInt for large Fibonacci numbers
let b = 1n;
let isSaving = false; // Flag to track if save is in progress
let pendingSave = false; // Flag to track if a save is queued
let serverStartTime = new Date();
let lastSaveTime = new Date();
let lastCommitTime = 0;
let lastManualSaveTime = 0;
const COMMIT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MANUAL_SAVE_COOLDOWN = 60 * 1000; // 1 minute

// Server specs (for display on frontend)
const SERVER_SPECS = {
  platform: 'Render.com Free Tier',
  ram: '512 MB',
  cpu: '0.1 vCPU'
};

// Track if GitHub integration is available
let githubAvailable = false;

// Broadcast to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Check if the repository exists and set githubAvailable flag
async function checkRepositoryExists() {
  try {
    await octokit.repos.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
    });
    console.log(`✓ Repository ${REPO_OWNER}/${REPO_NAME} found - GitHub saving enabled`);
    githubAvailable = true;
    return true;
  } catch (error) {
    if (error.status === 404) {
      console.log(`⚠ Repository ${REPO_OWNER}/${REPO_NAME} not found`);
      console.log(`  Please create it manually at: https://github.com/new`);
      console.log(`  Repository name: ${REPO_NAME}`);
      console.log(`  GitHub saving disabled until repository is created`);
    } else {
      console.error('Error checking repository:', error.message);
    }
    githubAvailable = false;
    return false;
  }
}

// Load state from GitHub
async function loadStateFromGitHub() {
  if (!githubAvailable) {
    console.log('GitHub not available, starting fresh');
    return;
  }
  
  // First, try to load all.json for complete history
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    allNumbers = parsed.numbers || [];
    count = parsed.count || allNumbers.length;
    
    if (allNumbers.length >= 2) {
      const lastTwo = allNumbers.slice(-2);
      a = BigInt(lastTwo[0]);
      b = BigInt(lastTwo[1]);
      currentNumbers = allNumbers.slice(-45);
      console.log(`Loaded ${allNumbers.length} numbers from all.json`);
      console.log(`Resuming from position ${count}`);
      return;
    }
  } catch (error) {
    if (error.status !== 404) {
      console.error('Error loading all.json:', error.message);
    }
  }
  
  // Fall back to README if all.json doesn't exist
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: README_PATH,
    });

    const content = Buffer.from(data.content, 'base64').toString('utf8');
    
    // Parse the total count from Statistics section
    const countMatch = content.match(/Total numbers computed: (\d+)/);
    if (countMatch) {
      count = parseInt(countMatch[1], 10);
      console.log(`Total numbers previously computed: ${count}`);
    }
    
    // Parse the README to get the last numbers
    const match = content.match(/## Latest 45 Digits\n\n```\n([\s\S]*?)\n```/);
    if (match) {
      const numbersText = match[1].trim();
      currentNumbers = numbersText.split('\n')
        .map(line => {
          const parts = line.split(': ');
          return parts.length >= 2 ? parts[1] : null;
        })
        .filter(num => num !== null);
      
      // Get the last two Fibonacci numbers to continue the sequence
      if (currentNumbers.length >= 2) {
        const lastTwo = currentNumbers.slice(-2);
        a = BigInt(lastTwo[0]);
        b = BigInt(lastTwo[1]);
        // Rebuild allNumbers from what we have
        allNumbers = [...currentNumbers];
        console.log(`Resuming from position ${count}`);
        console.log(`Last two numbers loaded for sequence continuation`);
      }
    }
  } catch (error) {
    if (error.status === 404) {
      console.log('No previous state found, starting fresh');
    } else {
      console.error('Error loading state from GitHub:', error.message);
    }
  }
}

// Save state to GitHub with queuing mechanism
async function saveStateToGitHub() {
  // Check if GitHub is available
  if (!githubAvailable) {
    // Try to check again in case repo was created
    const available = await checkRepositoryExists();
    if (!available) {
      console.log('GitHub save skipped - repository not available');
      return;
    }
  }

  // If already saving, mark that we need another save with latest data
  if (isSaving) {
    pendingSave = true;
    console.log('Save already in progress, queuing latest state...');
    return;
  }

  isSaving = true;
  pendingSave = false;

  try {
    // Capture current state at the moment of save
    const saveCount = count;
    const saveLast45 = currentNumbers.slice(-45);
    
    const startPosition = Math.max(1, saveCount - saveLast45.length + 1);
    const numbersText = saveLast45.map((num, idx) => {
      const position = startPosition + idx;
      return `${position}: ${num}`;
    }).join('\n');

    const readmeContent = `# Infinity Runner - Number Computation

This repository stores the progress of the Infinity Runner number computation.

## Latest 45 Digits

\`\`\`
${numbersText}
\`\`\`

## Statistics

- Total numbers computed: ${saveCount}
- Last updated: ${new Date().toISOString()}

## About

This is an automated computation running a Fibonacci sequence. The server computes numbers continuously and saves progress every 10 minutes.
`;

    // Check if file exists
    let sha;
    try {
      const { data } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: README_PATH,
      });
      sha = data.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    // Update or create file
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: README_PATH,
      message: `Update computation progress: ${saveCount} numbers computed`,
      content: Buffer.from(readmeContent).toString('base64'),
      ...(sha && { sha }),
    });

    console.log(`Saved README to GitHub: ${saveCount} numbers`);

    // Save all.json with complete history
    const allNumbersData = {
      count: saveCount,
      lastUpdated: new Date().toISOString(),
      numbers: allNumbers
    };
    
    let allJsonSha;
    try {
      const { data } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: ALL_NUMBERS_PATH,
      });
      allJsonSha = data.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
      message: `Update all numbers: ${saveCount} total`,
      content: Buffer.from(JSON.stringify(allNumbersData, null, 2)).toString('base64'),
      ...(allJsonSha && { sha: allJsonSha }),
    });

    console.log(`Saved all.json to GitHub: ${allNumbers.length} numbers`);
    lastSaveTime = new Date();
    
    // Notify all clients about the save
    broadcast({
      type: 'save',
      lastSaveTime: lastSaveTime.toISOString(),
      count: saveCount
    });
  } catch (error) {
    console.error('Error saving to GitHub:', error.message);
  } finally {
    isSaving = false;
    
    // If a save was requested while we were saving, trigger another save with latest data
    if (pendingSave) {
      console.log('Processing queued save with latest data...');
      // Use setImmediate to avoid blocking and allow computation to continue
      setImmediate(() => saveStateToGitHub());
    }
  }
}

// Compute next Fibonacci number
function computeNext() {
  const next = a + b;
  a = b;
  b = next;
  
  count++;
  const numStr = next.toString();
  currentNumbers.push(numStr);
  allNumbers.push(numStr); // Add to complete history
  
  // Broadcast to all clients
  broadcast({
    type: 'number',
    number: numStr,
    position: count
  });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'init',
    count: count,
    currentNumber: b.toString(),
    last45: currentNumbers.slice(-45),
    serverSpecs: SERVER_SPECS,
    serverStartTime: serverStartTime.toISOString(),
    lastSaveTime: lastSaveTime.toISOString()
  }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Periodic save function (every 10 minutes)
function startPeriodicSave() {
  setInterval(() => {
    if (count > 0) {
      console.log(`Periodic save triggered (10 minutes elapsed, ${count} numbers computed)`);
      // Queue the save - it won't block computation
      saveStateToGitHub();
    }
  }, 10 * 60 * 1000); // 10 minutes in milliseconds
}

// Main computation loop
async function startComputation() {
  // Check if repository exists
  await checkRepositoryExists();
  
  // Load previous state
  await loadStateFromGitHub();
  
  // Start periodic saves
  startPeriodicSave();
  
  console.log('Starting computation...');
  
  // Compute a new number every 100ms
  setInterval(() => {
    computeNext();
  }, 100);
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await saveStateToGitHub();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await saveStateToGitHub();
  process.exit(0);
});

// API endpoints
app.get('/api/progress', (req, res) => {
    res.json(gameState);
});

app.post('/api/manual-save', async (req, res) => {
    const { pin } = req.body;

    if (!OWNER_PIN) {
        return res.status(500).json({ error: 'Owner PIN not configured on server' });
    }

    if (pin !== OWNER_PIN) {
        return res.status(403).json({ error: 'Invalid PIN' });
    }

    const now = Date.now();
    if (now - lastManualSaveTime < MANUAL_SAVE_COOLDOWN) {
        const remaining = Math.ceil((MANUAL_SAVE_COOLDOWN - (now - lastManualSaveTime)) / 1000);
        return res.status(429).json({ error: `Please wait ${remaining} seconds before saving again` });
    }

    try {
        await saveStateToGitHub();
        lastManualSaveTime = now;
        // Auto-save timer continues independently - no reset
        res.json({ success: true, message: 'Progress saved manually' });
    } catch (error) {
        console.error('Manual save failed:', error);
        res.status(500).json({ error: 'Failed to save progress' });
    }
});

app.post('/api/progress', (req, res) => {
  // ...existing code...
});

// Start the computation
startComputation();
