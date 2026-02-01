const express = require('express');
const sharp = require('sharp');
const fetch = require('node-fetch');
const cors = require('cors');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for all origins
app.use(cors());

// Function to get local network IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();
const SLICE_HEIGHT = 1500; // Height of each slice in pixels

// Simple in-memory cache
const imageCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Clean up old cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of imageCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      imageCache.delete(key);
    }
  }
}, 60 * 1000);

// Serve static files from public directory
app.use(express.static('public'));

// Root endpoint serves the download page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/slice', async (req, res) => {
  try {
    const { url, index } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }
    
    let buffer;

    // 1. Check Cache First
    if (imageCache.has(url)) {
      console.log(`Using cached image: ${url}`);
      buffer = imageCache.get(url).buffer;
    } else {
      console.log(`Downloading new image: ${url}`);
      
      // Use exact headers from user's working browser (Edge on Android) including Cookie
      const headers = {
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'accept-language': 'fr,fr-FR;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6,id;q=0.5',
        'accept-encoding': 'identity', // Force uncompressed response
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'priority': 'u=1, i',
        'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'sec-fetch-dest': 'image',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'same-site',
        'cookie': '_ga=GA1.1.1196933709.1769800398; _ga_W8MD69ZT8X=GS2.1.s1769964652$o5$g1$t1769965103$j20$l0$h0; cf_clearance=VFbE1efpHGOsn1aKTH6MqBg42PoxRbpiR1rb97G0Jm0-1769965103-1.2.1.1-tDi.AdpnTmRLiWswNdjQSLbUQpZA4Rp9HLm.pATl3uHrwQHO2et3kIsFp4D1qgGaUE0Lb13NiOn_kviqSIEBInWnNYzTJzySKxtbc626VfBQ3MQ7DGwfgmMttpLGzVg74wWVNpsKep7YyWTMxCVGvJbw54eJRz8ch1opwyp3a9EKDUwGaFcf3iq346634pEkxQNieG3x6NMzEgw_YSFzkexqCLNAt_cMESw86v7RHyg',
        'Referer': 'https://mangatek.com/'
      };

      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText} (${response.status})`);
      
      // Buffer the entire response
      buffer = await response.buffer();

      // Verify Content-Length if present
      const expectedSize = response.headers.get('content-length');
      if (expectedSize && buffer.length != expectedSize) {
          console.warn(`Warning: Content-Length mismatch. Expected: ${expectedSize}, Received: ${buffer.length}`);
           // Option: throw error if we want to be strict, or just log for now to see if it fixes it
           // throw new Error('Incomplete download: Size mismatch');
      }
      
      // Save to cache
      imageCache.set(url, { buffer, timestamp: Date.now() });
    }
    
    // Get image metadata
    const metadata = await sharp(buffer).metadata();
    const { width, height } = metadata;
    
    // If index is provided, return specific slice
    if (index !== undefined) {
      const sliceIndex = parseInt(index);
      const y = sliceIndex * SLICE_HEIGHT;
      const sliceHeight = Math.min(SLICE_HEIGHT, height - y);
      
      if (y >= height) {
        return res.status(404).json({ error: 'Slice index out of bounds' });
      }
      
      console.log(`Extracting slice ${sliceIndex} (y: ${y}, height: ${sliceHeight})`);
      
      // Extract and return the slice
      const slice = await sharp(buffer)
        .extract({ left: 0, top: y, width: width, height: sliceHeight })
        .jpeg({ quality: 90 })
        .toBuffer();
      
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=31536000');
      res.send(slice);
    } else {
      // Return slice info
      const numSlices = Math.ceil(height / SLICE_HEIGHT);
      const slices = [];
      
      // Determine the base URL
      // If running on Render, RENDER_EXTERNAL_URL will be set
      // Otherwise, fallback to local IP
      let baseUrl;
      if (process.env.RENDER_EXTERNAL_URL) {
          baseUrl = `${process.env.RENDER_EXTERNAL_URL}`;
          // Ensure no trailing slash
          baseUrl = baseUrl.replace(/\/$/, '');
      } else {
          baseUrl = `http://${LOCAL_IP}:${PORT}`;
      }
      
      for (let i = 0; i < numSlices; i++) {
        const y = i * SLICE_HEIGHT;
        const sliceHeight = Math.min(SLICE_HEIGHT, height - y);
        
        slices.push({
          index: i,
          url: `${baseUrl}/slice?url=${encodeURIComponent(url)}&index=${i}`,
          y,
          height: sliceHeight,
          width
        });
      }
      
      res.json({
        originalWidth: width,
        originalHeight: height,
        sliceHeight: SLICE_HEIGHT,
        numSlices,
        slices
      });
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Manga Slicer Backend running on port ${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}`);
  if (!process.env.RENDER_EXTERNAL_URL) {
      console.log(`   Network: http://${LOCAL_IP}:${PORT}`);
  }
});
