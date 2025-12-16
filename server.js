const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

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

// State management
let currentNumbers = [];
let count = 0;
let a = 0n; // Using BigInt for large Fibonacci numbers
let b = 1n;
let isSaving = false; // Flag to prevent concurrent saves

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

// Save state to GitHub
async function saveStateToGitHub() {
  try {
    const last45 = currentNumbers.slice(-45);
    const startPosition = Math.max(1, count - last45.length + 1);
    const numbersText = last45.map((num, idx) => {
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

- Total numbers computed: ${count}
- Last updated: ${new Date().toISOString()}

## About

This is an automated computation running a Fibonacci sequence. The server computes numbers continuously and saves progress every 45 numbers.
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
      message: `Update computation progress: ${count} numbers computed`,
      content: Buffer.from(readmeContent).toString('base64'),
      ...(sha && { sha }),
    });

    console.log(`Saved progress to GitHub: ${count} numbers`);
  } catch (error) {
    console.error('Error saving to GitHub:', error.message);
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

  // Save every 45 numbers
  if (count % 45 === 0 && !isSaving) {
    console.log(`Reached ${count} numbers, saving to GitHub...`);
    isSaving = true;
    saveStateToGitHub().finally(() => {
      isSaving = false;
    });
  }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'init',
    count: count,
    currentNumber: b.toString(),
    last45: currentNumbers.slice(-45)
  }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Main computation loop
async function startComputation() {
  // Load previous state
  await loadStateFromGitHub();
  
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

// Start the computation
startComputation();
