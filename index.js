const fs = require('fs');
const path = require('path');
const { VertexAI } = require('@google-cloud/vertexai');
// Path to your service account key file
const serviceAccountPath = path.join(__dirname, "./ondemand.json");
// Set environment variable for authentication
process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
// Initialize Vertex AI with your Cloud project and location
const projectId = 'ondemand-421015';
const location = 'us-east4';
// Initialize the Vertex AI client
const vertexAI = new VertexAI({
  project: projectId,
  location: location,
});
const model = 'gemini-1.5-flash';
// Function to generate content
async function generateContent(prompt) {
  console.log('Generating content for prompt:', prompt);
  try {
    const generativeModel = vertexAI.preview.getGenerativeModel({
      model: model,
      generation_config: {
        max_output_tokens: 2048,
        temperature: 0.2,
        top_p: 0.8,
        top_k: 40
      },
    });
    const req = {
      contents: [{role: 'user', parts: [{text: prompt}]}],
    };
    const streamingResp = await generativeModel.generateContentStream(req);
    let fullResponse = '';
    // Process each chunk in the streaming response
    for await (const chunk of streamingResp.stream) {
      if (chunk.candidates && chunk.candidates.length > 0) {
        const candidate = chunk.candidates[0]; // Assuming the first candidate is the one we need
        if (candidate.content) {
          // Convert content to string if it's an object
          const contentStr = typeof candidate.content === 'object' ? JSON.stringify(candidate.content) : candidate.content;
          fullResponse += contentStr; // Concatenate content
        }
      } else {
        // Log the entire chunk if no candidates found
        console.log('Received chunk without candidates:', chunk);
      }
    }
    console.log('Full response:', fullResponse);
  } catch (error) {
    console.error('Error generating content:', error);
    console.error('Error details:', error.details || error.message);
  }
}
// Run the generation
const prompt = "Tell me a short story about a brave knight.";
generateContent(prompt);