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

// GitHub setup - disable request logging
const octokit = new Octokit({
  auth: GITHUB_TOKEN,
  log: {
    debug: () => {},
    info: () => {},
    warn: console.warn,
    error: console.error
  }
});

const README_PATH = 'README.md';
const ALL_NUMBERS_PATH = 'all.json';
const CHUNK_SIZE = 1000; // Legacy - not used anymore
const MAX_CHUNK_BYTES = 900 * 1024; // 900KB max per chunk (under GitHub's 1MB API limit)
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB GitHub limit

// State management
let currentNumbers = [];
let newNumbers = []; // Only store NEW numbers since last save (not ALL numbers)
let count = 0;
let a = 0n; // Using BigInt for large Fibonacci numbers
let b = 1n;
let isSaving = false; // Flag to track if save is in progress
let pendingSave = false; // Flag to track if a save is queued
let saveQueue = []; // Queue for save operations
let isProcessingQueue = false;
const MAX_NEW_NUMBERS_BUFFER = 500; // Limit buffer to prevent memory issues
let serverStartTime = new Date();
let lastSaveTime = new Date();
let autoSaveStartTime = new Date(); // Tracks when current auto-save cycle started
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

// Split numbers array into chunks based on byte size (not count)
// Each chunk stays under MAX_CHUNK_BYTES, and numbers are never split between chunks
function splitNumbersBySize(numbers) {
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  const overhead = 50; // JSON overhead per number (quotes, comma, newline, etc.)
  
  for (const num of numbers) {
    const numSize = num.length + overhead;
    
    // If adding this number would exceed limit, start new chunk
    if (currentSize + numSize > MAX_CHUNK_BYTES && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }
    
    currentChunk.push(num);
    currentSize += numSize;
  }
  
  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

// Check if a chunk needs resplitting (too large)
function chunkNeedsResplit(chunkData) {
  const content = JSON.stringify(chunkData, null, 2);
  return Buffer.byteLength(content, 'utf8') > MAX_CHUNK_BYTES;
}

// Load chunked data - only load the LAST chunk to save RAM
// We only need the last 2 numbers to continue the Fibonacci sequence
async function loadChunkedData(indexData) {
  const chunks = Array.isArray(indexData.chunks) ? indexData.chunks : [];
  const numChunks = chunks.length;
  
  if (numChunks === 0) {
    console.log('No chunks to load');
    return false;
  }
  
  console.log(`Found ${numChunks} chunks, loading only the last one to save RAM...`);
  
  // Get the last chunk info
  const lastChunk = chunks[numChunks - 1];
  const chunkPath = lastChunk?.path || `chunks/chunk_${numChunks - 1}.json`;
  
  try {
    // Use raw URL to load (no size limit)
    const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${chunkPath}`;
    const response = await fetch(rawUrl);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const content = await response.text();
    const chunkData = JSON.parse(content);
    
    if (!chunkData.numbers || chunkData.numbers.length < 2) {
      console.log('Last chunk has insufficient numbers');
      return false;
    }
    
    // Get the last two numbers to continue the sequence
    const lastTwo = chunkData.numbers.slice(-2);
    a = BigInt(lastTwo[0]);
    b = BigInt(lastTwo[1]);
    
    // Set count from index data
    count = indexData.computedCount || indexData.totalNumbers || 0;
    
    // Only keep last 45 numbers for display
    currentNumbers = chunkData.numbers.slice(-45);
    
    // Keep newNumbers empty - we don't need previous numbers in memory
    // We'll only save NEW numbers going forward
    newNumbers = [];
    
    console.log(`Loaded last chunk (${chunkData.numbers.length} numbers)`);
    console.log(`Resuming from position ${count}`);
    console.log(`RAM saved by not loading ${numChunks - 1} previous chunks`);
    
    return true;
  } catch (error) {
    console.log(`Failed to load last chunk: ${error.message}`);
    return false;
  }
}

// Load state from GitHub
async function loadStateFromGitHub() {
  if (!githubAvailable) {
    console.log('GitHub not available, starting fresh');
    return;
  }
  
  // First, try to load all.json index for chunked data
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    
    // Check if data is chunked format (has chunks array)
    if (parsed.chunks && Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
      console.log(`Found chunked index: ${parsed.chunks.length} chunks, ${parsed.totalNumbers} total numbers`);
      const success = await loadChunkedData(parsed);
      if (success) {
        return;
      }
      console.log('Chunk loading failed, falling back to README...');
    } else if (parsed.numbers && parsed.numbers.length > 0) {
      // Old single-file format - DON'T load all into memory, just get last 2
      const loadedNumbers = parsed.numbers;
      count = parsed.count || loadedNumbers.length;
    
      if (loadedNumbers.length >= 2) {
        const lastTwo = loadedNumbers.slice(-2);
        a = BigInt(lastTwo[0]);
        b = BigInt(lastTwo[1]);
        currentNumbers = loadedNumbers.slice(-45);
        newNumbers = []; // Start fresh, don't keep old numbers in memory
        console.log(`Loaded state from all.json (old format, ${loadedNumbers.length} numbers)`);
        console.log(`Resuming from position ${count}`);
        return;
      }
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
        
        // DON'T regenerate all numbers - this causes OOM!
        // Just continue from where we left off
        newNumbers = []; // Start fresh
        console.log(`Resuming from position ${count} (using last 2 numbers from README)`);
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

// Regenerate Fibonacci sequence from the beginning (REMOVED - causes OOM)
// We no longer regenerate all numbers, just continue from last known state

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

    // Queue the all.json save to run async without blocking
    queueAllNumbersSave(saveCount);
    
    lastSaveTime = new Date();
    
    // Notify all clients about the save
    broadcast({
      type: 'save',
      lastSaveTime: lastSaveTime.toISOString(),
      autoSaveStartTime: autoSaveStartTime.toISOString(),
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

// Queue all.json save operation
function queueAllNumbersSave(saveCount) {
  // Only queue if we have new numbers to save
  if (newNumbers.length === 0) {
    console.log('No new numbers to save');
    return;
  }
  
  // Take ownership of current buffer and reset it immediately
  const numbersToSave = newNumbers;
  newNumbers = []; // Reset buffer immediately to prevent memory growth
  
  saveQueue.push({ count: saveCount, numbers: numbersToSave });
  processQueue();
}

// Process save queue without blocking computation
async function processQueue() {
  if (isProcessingQueue || saveQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (saveQueue.length > 0) {
    // Only process the latest save, skip older ones
    const job = saveQueue.pop();
    saveQueue.length = 0; // Clear remaining older jobs
    
    try {
      await saveAllNumbersToGitHub(job.count, job.numbers);
    } catch (error) {
      console.error('Queue save error:', error.message);
    }
    
    // Small delay to not hammer GitHub API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  isProcessingQueue = false;
}

// Save all numbers using chunked files to avoid GitHub size limits
// Now optimized: newNumbers only contains NEW numbers since last save
// We append these to the last chunk or create new chunks as needed
async function saveAllNumbersToGitHub(saveCount, numbersToSave) {
  // First, get the current index to know what chunks exist
  let indexData = { chunks: [], totalNumbers: 0, lastChunkCount: 0 };
  let indexSha;
  
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
    });
    indexSha = data.sha;
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    
    if (parsed.chunks && Array.isArray(parsed.chunks)) {
      indexData = parsed;
      console.log(`Found ${indexData.chunks.length} existing chunks with ${indexData.totalNumbers} numbers`);
    }
  } catch (error) {
    if (error.status === 404) {
      console.log('No existing all.json index, creating new chunked storage');
    } else {
      console.log('Error reading index:', error.message);
    }
  }

  // If no new numbers to save, skip
  if (!numbersToSave || numbersToSave.length === 0) {
    console.log('No new numbers to save');
    return;
  }

  console.log(`Saving ${numbersToSave.length} new numbers`);

  // Split new numbers by size
  const newChunks = splitNumbersBySize(numbersToSave);
  let startPosition = indexData.totalNumbers + 1;
  
  // Save each new chunk
  for (let i = 0; i < newChunks.length; i++) {
    const chunkNumbers = newChunks[i];
    const chunkIndex = indexData.chunks.length; // Next chunk index
    
    await saveChunk(chunkIndex, chunkNumbers);
    
    indexData.chunks.push({
      index: chunkIndex,
      path: `chunks/chunk_${chunkIndex}.json`,
      count: chunkNumbers.length,
      startPosition: startPosition,
      endPosition: startPosition + chunkNumbers.length - 1
    });
    
    startPosition += chunkNumbers.length;
    
    // Rate limit
    if (i < newChunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Update index with retry logic for SHA conflicts
  indexData.totalNumbers += numbersToSave.length;
  indexData.lastChunkCount = newChunks[newChunks.length - 1]?.length || 0;
  indexData.lastUpdated = new Date().toISOString();
  indexData.computedCount = saveCount;
  
  const indexContent = JSON.stringify(indexData, null, 2);
  
  // Retry logic for index update
  let indexRetries = 0;
  const MAX_INDEX_RETRIES = 3;
  
  while (indexRetries < MAX_INDEX_RETRIES) {
    try {
      // Re-fetch SHA if this is a retry
      if (indexRetries > 0) {
        try {
          const { data } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: ALL_NUMBERS_PATH,
          });
          indexSha = data.sha;
          console.log(`Refetched index SHA: ${indexSha.substring(0, 7)}`);
        } catch (e) {
          indexSha = null;
        }
      }
      
      await octokit.repos.createOrUpdateFileContents({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: ALL_NUMBERS_PATH,
        message: `Add ${numbersToSave.length} numbers: now ${indexData.totalNumbers} total in ${indexData.chunks.length} chunks`,
        content: Buffer.from(indexContent).toString('base64'),
        ...(indexSha && { sha: indexSha }),
      });
      
      console.log(`Saved: ${indexData.totalNumbers} total numbers in ${indexData.chunks.length} chunks`);
      break; // Success, exit retry loop
    } catch (error) {
      if (error.status === 409 && indexRetries < MAX_INDEX_RETRIES - 1) {
        indexRetries++;
        console.log(`Index SHA conflict, retrying (${indexRetries}/${MAX_INDEX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        throw error;
      }
    }
  }
  
  // Numbers already cleared when we took ownership in queueAllNumbersSave
}

// Save a new chunk file with retry logic for SHA conflicts
async function saveChunk(chunkIndex, numbers, retryCount = 0) {
  const MAX_RETRIES = 3;
  const chunkPath = `chunks/chunk_${chunkIndex}.json`;
  const chunkData = {
    chunkIndex,
    count: numbers.length,
    numbers: numbers
  };
  
  const content = JSON.stringify(chunkData, null, 2);
  const contentSize = Buffer.byteLength(content, 'utf8');
  console.log(`Chunk ${chunkIndex} size: ${(contentSize / 1024 / 1024).toFixed(2)}MB`);
  
  // Check if file is too large (GitHub limit is ~100MB but API has issues with large files)
  if (contentSize > 50 * 1024 * 1024) {
    console.log(`Warning: Chunk ${chunkIndex} is very large (${(contentSize / 1024 / 1024).toFixed(2)}MB)`);
  }
  
  // Check if chunk exists (for SHA) - needed to overwrite
  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: chunkPath,
    });
    sha = data.sha;
    console.log(`Found existing chunk ${chunkIndex}, will overwrite (SHA: ${sha.substring(0, 7)})`);
  } catch (e) {
    // New file - that's fine
  }
  
  try {
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: chunkPath,
      message: `Create chunk ${chunkIndex}: ${numbers.length} numbers`,
      content: Buffer.from(content).toString('base64'),
      ...(sha && { sha }),
    });
    console.log(`Saved chunk ${chunkIndex}: ${numbers.length} numbers`);
  } catch (error) {
    // Handle SHA conflict (409) with retry
    if (error.status === 409 && retryCount < MAX_RETRIES) {
      console.log(`SHA conflict on chunk ${chunkIndex}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      return saveChunk(chunkIndex, numbers, retryCount + 1);
    }
    console.error(`Error saving chunk ${chunkIndex}: ${error.status} - ${error.message}`);
    throw error;
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
  
  // Only keep last 100 in currentNumbers to limit memory
  if (currentNumbers.length > 100) {
    currentNumbers = currentNumbers.slice(-50);
  }
  
  // Add to new numbers buffer for saving
  newNumbers.push(numStr);
  
  // Emergency save if buffer gets too large (prevents OOM)
  if (newNumbers.length >= MAX_NEW_NUMBERS_BUFFER) {
    console.log(`Buffer limit reached (${MAX_NEW_NUMBERS_BUFFER}), triggering early save...`);
    saveStateToGitHub();
  }
  
  // Broadcast to all clients (only send position and digit count to save bandwidth)
  broadcast({
    type: 'number',
    position: count,
    digits: numStr.length
  });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // Send current state to new client (only send digit count, not full numbers)
  const currentNum = b.toString();
  ws.send(JSON.stringify({
    type: 'init',
    count: count,
    digits: currentNum.length,
    serverSpecs: SERVER_SPECS,
    serverStartTime: serverStartTime.toISOString(),
    lastSaveTime: lastSaveTime.toISOString(),
    autoSaveStartTime: autoSaveStartTime.toISOString()
  }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Periodic save function (every 5 minutes)
function startPeriodicSave() {
  setInterval(() => {
    if (count > 0) {
      console.log(`Periodic save triggered (5 minutes elapsed, ${count} numbers computed)`);
      // Reset auto-save timer for the next cycle
      autoSaveStartTime = new Date();
      // Queue the save - it won't block computation
      saveStateToGitHub();
    }
  }, 5 * 60 * 1000); // 5 minutes in milliseconds
}

// Main computation loop
async function startComputation() {
  // Check if repository exists
  await checkRepositoryExists();
  
  // Load previous state
  await loadStateFromGitHub();
  
  // If starting fresh, add the initial Fibonacci numbers (0, 1) to the history
  if (count === 0 && newNumbers.length === 0) {
    console.log('Starting fresh - adding initial Fibonacci numbers (0, 1)');
    // Add the starting numbers to the history
    // Position 1 = 0, Position 2 = 1 (these are a and b before any computation)
    newNumbers.push('0');  // F(0) = 0
    newNumbers.push('1');  // F(1) = 1
    currentNumbers.push('0');
    currentNumbers.push('1');
    count = 2;  // We already have 2 numbers
    // a=0, b=1 are already set, so next computeNext() will compute F(2) = 1
  }
  
  // Start periodic saves
  startPeriodicSave();
  
  console.log('Starting computation...');
  
  // Compute a new number every 100ms
  setInterval(() => {
    computeNext();
  }, 100);
}

// Graceful shutdown with error handling
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  try {
    await saveStateToGitHub();
    console.log('Shutdown save completed');
  } catch (error) {
    console.log('Shutdown save failed (this is normal on Render):', error.message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  try {
    await saveStateToGitHub();
    console.log('Shutdown save completed');
  } catch (error) {
    console.log('Shutdown save failed (this is normal on Render):', error.message);
  }
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
