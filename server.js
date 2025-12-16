const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

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
  auth: process.env.GITHUB_TOKEN
});

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Sirco-web';
const GITHUB_REPO = process.env.GITHUB_REPO || 'infinity-runner-data';
const README_PATH = 'README.md';
const REPO_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.GITHUB_REPO;
const OWNER_PIN = process.env.OWNER_PIN;

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
  console.error('GitHub token, owner, and repo must be configured');
  process.exit(1);
}

// State management
let currentNumbers = [];
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

// Broadcast to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Load state from GitHub
async function loadStateFromGitHub() {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: README_PATH,
    });

    const content = Buffer.from(data.content, 'base64').toString('utf8');
    
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
        count = currentNumbers.length;
        console.log(`Resuming from position ${count}`);
        console.log(`Last two numbers: ${a}, ${b}`);
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
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: README_PATH,
      });
      sha = data.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    // Update or create file
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: README_PATH,
      message: `Update computation progress: ${saveCount} numbers computed`,
      content: Buffer.from(readmeContent).toString('base64'),
      ...(sha && { sha }),
    });

    console.log(`Saved progress to GitHub: ${saveCount} numbers`);
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
  currentNumbers.push(next.toString());
  
  // Broadcast to all clients
  broadcast({
    type: 'number',
    number: next.toString(),
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
        await saveProgressToGitHub();
        lastManualSaveTime = now;
        // Reset automatic timer to avoid double saving shortly after
        lastCommitTime = now;
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
