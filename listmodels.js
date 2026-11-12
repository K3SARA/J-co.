require('dotenv').config();

fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
  headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }
})
  .then((r) => r.json())
  .then((d) => {
    if (d.error) return console.log('Error:', d.error.message);
    (d.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .forEach((m) => console.log(m.name.replace('models/', '')));
  });