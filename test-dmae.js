const fs = require('fs');
const path = require('path');

// Read the worldbook file
const content = fs.readFileSync(path.join(__dirname, 'prompts', 'worldbook', 'world.md'), 'utf8');
const lines = content.split('\n');

// Parse the first entry's keywords
for (const line of lines) {
  if (line.startsWith('- 触发词:') && line.includes('\u7fc1')) { // 翁
    const kwLine = line.replace(/^-\s*触发词[：:]/, '').trim();
    const keywords = kwLine.split(/[,，、]/).map(k => k.trim()).filter(Boolean);
    
    // Simulate user text
    const userText = '\u4ecb\u7ecd\u4e00\u4e0b\u7fc1\u6cd5\u7f57\u65af'; // 介绍一下翁法罗斯
    
    console.log('Keywords:', keywords);
    console.log('Keyword[0]:', keywords[0], 'length:', keywords[0].length);
    console.log('UserText:', userText, 'length:', userText.length);
    console.log('UserText bytes:', Buffer.from(userText).toString('hex'));
    console.log('Keyword[0] bytes:', Buffer.from(keywords[0]).toString('hex'));
    console.log('Match result:', userText.includes(keywords[0]));
    
    // Test each keyword
    for (const kw of keywords) {
      console.log(`  "${kw}" in userText:`, userText.includes(kw));
    }
    break;
  }
}

// Also test with story.md trigger words
console.log('\n--- Story.md test ---');
const storyContent = fs.readFileSync(path.join(__dirname, 'prompts', 'worldbook', 'story.md'), 'utf8');
const storyLines = storyContent.split('\n');
for (const line of storyLines) {
  if (line.startsWith('- 触发词:') && line.includes('\u4e3b\u7ebf')) { // 主线
    const kwLine = line.replace(/^-\s*触发词[：:]/, '').trim();
    const keywords = kwLine.split(/[,，、]/).map(k => k.trim()).filter(Boolean);
    
    const userText2 = '\u4e3b\u7ebf\u662f\u4ec0\u4e48'; // 主线是什么
    
    console.log('Keywords:', keywords);
    console.log('UserText:', userText2, 'length:', userText2.length);
    console.log('Match "主线":', userText2.includes('\u4e3b\u7ebf'));
    
    for (const kw of keywords) {
      if (userText2.includes(kw)) {
        console.log(`  HIT: "${kw}"`);
      }
    }
    break;
  }
}
