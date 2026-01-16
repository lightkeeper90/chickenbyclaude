// Chickens by Claude - Backend Server
// Captures screen, analyzes with Claude Vision, pushes updates to overlay via WebSocket

import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import cors from 'cors';
import screenshot from 'screenshot-desktop';
import sharp from 'sharp';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Initialize Claude
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// Config
const CONFIG = {
    port: process.env.PORT || 3000,
    analysisInterval: 30000, // 30 seconds between analyses
    captureRegion: null, // null = full screen, or { x, y, width, height }
};

// WebSocket for real-time updates to overlay
let wss;
let clients = [];

// Analysis prompt for chickens
const ANALYSIS_PROMPT = `You are an AI monitoring system analyzing a live video feed of a chicken coop. Analyze this image and provide detailed observations.

Return a JSON object with this exact structure:
{
    "temperature": 72,
    "humidity": 58,
    "eggs": 7,
    "activeCount": 9,
    "behaviors": [
        {"label": "behavior name", "value": "observation", "status": "assessment"}
    ],
    "health": [
        {"label": "health metric", "value": "observation", "status": "assessment"}
    ],
    "events": [
        {"time": "HH:MM", "event": "description with <span class='highlight'>highlighted</span> parts"}
    ],
    "chickens": [
        {"name": "Henrietta", "state": "active", "activity": "Foraging"},
        {"name": "Nugget", "state": "resting", "activity": "Nesting"}
    ]
}

Chicken names to use: Henrietta (alpha hen), Nugget, Colonel (rooster), Goldie, Pepper, Maple, Cinnamon, Biscuit

States can be: "active", "resting", or "alert"

Be creative and detailed with observations. Look for:
- What chickens are doing (foraging, dust bathing, preening, nesting, eating, drinking)
- Social interactions and pecking order dynamics
- Health indicators (feather quality, comb color, movement patterns)
- Environmental conditions
- Any notable events or behaviors

Make it entertaining and scientific-sounding. Keep observations concise but informative.`;

// Capture screen
async function captureScreen() {
    try {
        const imgBuffer = await screenshot({ format: 'png' });
        
        // Resize for API (Claude accepts up to 1568px on longest side)
        const optimized = await sharp(imgBuffer)
            .resize(1200, 1200, { fit: 'inside' })
            .jpeg({ quality: 85 })
            .toBuffer();
        
        return optimized.toString('base64');
    } catch (error) {
        console.error('Screen capture error:', error);
        throw error;
    }
}

// Analyze with Claude
async function analyzeFrame(imageBase64) {
    try {
        console.log('Sending frame to Claude for analysis...');
        
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/jpeg',
                                data: imageBase64
                            }
                        },
                        {
                            type: 'text',
                            text: ANALYSIS_PROMPT
                        }
                    ]
                }
            ]
        });

        const text = response.content[0].text;
        
        // Extract JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            console.log('Analysis complete:', data.behaviors?.[0]?.label || 'success');
            return data;
        }
        
        throw new Error('No JSON in response');
    } catch (error) {
        console.error('Claude API error:', error.message);
        throw error;
    }
}

// Broadcast to all connected overlays
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(message);
        }
    });
}

// Main analysis loop
async function runAnalysis() {
    try {
        console.log('\n--- Running analysis ---');
        const frame = await captureScreen();
        const analysis = await analyzeFrame(frame);
        broadcast(analysis);
        console.log('Broadcast to', clients.length, 'clients');
    } catch (error) {
        console.error('Analysis cycle failed:', error.message);
    }
}

// API Routes
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        clients: clients.length,
        interval: CONFIG.analysisInterval 
    });
});

// Manual trigger
app.post('/api/analyze', async (req, res) => {
    try {
        await runAnalysis();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get current frame (for debugging)
app.get('/api/frame', async (req, res) => {
    try {
        const frame = await captureScreen();
        res.json({ image: frame });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
const server = app.listen(CONFIG.port, () => {
    console.log(`
🐔 Chickens by Claude - Server Running
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📺 Overlay URL: http://localhost:${CONFIG.port}/overlay.html
⏱️  Analysis interval: ${CONFIG.analysisInterval / 1000}s
🔑 API Key: ${process.env.ANTHROPIC_API_KEY ? '✓ Set' : '✗ Missing!'}

Add overlay.html as Browser Source in OBS.
    `);
});

// WebSocket server for real-time updates
wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('Overlay connected');
    clients.push(ws);
    
    ws.on('close', () => {
        clients = clients.filter(c => c !== ws);
        console.log('Overlay disconnected');
    });
});

// Start analysis loop
console.log('Starting analysis loop...');
setInterval(runAnalysis, CONFIG.analysisInterval);

// Run first analysis after 5 seconds
setTimeout(runAnalysis, 5000);
