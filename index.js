const dotenv = require("dotenv");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const os = require('os');
const {
  GoogleGenerativeAI,
} = require("@google/generative-ai");

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
});

const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

const MAX_WIDTH = 512;
const MAX_HEIGHT = 512;
const MAX_PAYLOAD_SIZE = 5242880; // 5 MB
const BATCH_SIZE_LIMIT = 10; // Smaller batch size to avoid hitting limits
const CACHE_SIZE = 1000;
const MAX_RETRIES = 5;
const FRAME_SKIP_INTERVAL = 5;
const REQUEST_THROTTLE_DELAY = 10000; // Increase delay between batches in milliseconds

const requestQueue = [];
let isProcessing = false;

async function resizeFrame(framePath) {
  const image = sharp(framePath);
  const metadata = await image.metadata();

  if (metadata.width > MAX_WIDTH || metadata.height > MAX_HEIGHT) {
    const tempPath = path.join(os.tmpdir(), `resized_${path.basename(framePath)}`);
    await image
      .resize({
        width: Math.min(metadata.width, MAX_WIDTH),
        height: Math.min(metadata.height, MAX_HEIGHT),
        fit: sharp.fit.inside,
        withoutEnlargement: true,
        quality: 80,
      })
      .toFile(tempPath);

    fs.renameSync(tempPath, framePath);
  }
}

async function analyzeBatch(frames, analysisCache) {
  const frameData = frames.map((framePath) => fs.readFileSync(framePath, { encoding: "base64" }));

  const cachedResults = frameData.map((data) => analysisCache.get(data));
  if (cachedResults.every((result) => result !== undefined)) {
    console.log("All frames have cached results.");
    return cachedResults;
  }

  const chatSession = model.startChat({
    generationConfig,
    history: [],
  });

  const results = await sendRequestWithExponentialBackoff(chatSession, frameData);

  results.forEach((result, index) => {
    analysisCache.set(frameData[index], result);
    if (analysisCache.size > CACHE_SIZE) {
      analysisCache.delete(analysisCache.keys().next().value);
    }
  });

  return results;
}

async function sendRequestWithExponentialBackoff(chatSession, frameData) {
  let retryCount = 0;
  let backoffDelay = 2000;

  while (retryCount < MAX_RETRIES) {
    try {
      const result = await chatSession.sendMessage(`Analyze these frames: ${frameData.join(", ")}`);
      return result;
    } catch (error) {
      if (error.status === 429) {
        console.warn("Too Many Requests. Retrying after", backoffDelay, "milliseconds.");
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        retryCount++;
        backoffDelay *= 2;
      } else {
        console.error("Error sending request:", error);
        throw error;
      }
    }
  }

  console.error("Failed to send request after retries.");
  throw new Error("Maximum retries reached.");
}

async function extractFrames(videoPath, fps) {
  return new Promise((resolve, reject) => {
    const outputDir = path.join(__dirname, "frames");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    ffmpeg(videoPath)
      .output(`${outputDir}/frame-%04d.png`)
      .outputOptions([`-vf fps=${fps}`])
      .on("end", () => {
        console.log("Frames extracted");
        resolve(outputDir);
      })
      .on("error", (err) => {
        console.error("Error extracting frames:", err);
        reject(err);
      })
      .run();
  });
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const { batch, analysisCache, resolve } = requestQueue.shift();

    try {
      const results = await analyzeBatch(batch, analysisCache);
      results.forEach((result) => {
        console.log(result?.response?.text() || "No response text found.");
      });
    } catch (error) {
      console.error("Error analyzing batch:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, REQUEST_THROTTLE_DELAY));
  }

  isProcessing = false;
}

async function run() {
  const videoPath = "10 SECONDS VIDEO CLIP.mp4";
  const fps = 1;

  try {
    const framesDir = await extractFrames(videoPath, fps);
    const frameFiles = fs.readdirSync(framesDir).map((file) => path.join(framesDir, file));

    let batch = [];
    let batchSize = 0;

    const analysisCache = new Map();

    for (const framePath of frameFiles) {
      const frameSize = fs.statSync(framePath).size;

      if (batchSize + frameSize > MAX_PAYLOAD_SIZE || batch.length >= BATCH_SIZE_LIMIT) {
        requestQueue.push({ batch, analysisCache, resolve: () => {} });

        batch = [];
        batchSize = 0;

        if (!isProcessing) {
          processQueue();
        }
      }

      batch.push(framePath);
      batchSize += frameSize;
    }

    if (batch.length > 0) {
      requestQueue.push({ batch, analysisCache, resolve: () => {} });

      if (!isProcessing) {
        processQueue();
      }
    }
  } catch (error) {
    console.error("Error processing video:", error);
  }
}

run();
