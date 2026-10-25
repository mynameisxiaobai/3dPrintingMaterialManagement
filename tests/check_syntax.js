// Extract JS from the HTML file and check syntax
// 不写死绝对路径：从自身位置推 <项目根>/web/filament-manager.html
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'filament-manager.html'),
  'utf8'
);

// Extract content between <script> and </script>
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) { console.log('No script found'); process.exit(1); }

const js = match[1];
try {
  new Function(js);
  console.log('JS syntax OK!');
} catch(e) {
  console.log('JS Syntax Error:', e.message);
  // Find approximate line
  const lines = js.split('\n');
  const approxLine = e.message.match(/(\d+)/);
  if (approxLine) {
    const l = parseInt(approxLine[1]);
    console.log('Context:');
    for (let i = Math.max(0,l-3); i < Math.min(lines.length, l+3); i++) {
      console.log(`${i+1}: ${lines[i]}`);
    }
  }
  process.exit(1);   // 语法错必须让 npm test 的 && 链断掉，否则错着也算通过
}
