const fs = require('fs');
const path = require('path');

const gypPath = path.join(__dirname, '..', 'node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp');

if (!fs.existsSync(gypPath)) {
  console.log('node-pty winpty.gyp not found, skipping patch.');
  process.exit(0);
}

let content = fs.readFileSync(gypPath, 'utf8');
let patched = false;

if (content.includes('cd shared && GetCommitHash.bat')) {
  content = content.replace('cd shared && GetCommitHash.bat', 'cd shared && .\\\\GetCommitHash.bat');
  patched = true;
}
if (content.includes('cd shared && UpdateGenVersion.bat')) {
  content = content.replace('cd shared && UpdateGenVersion.bat', 'cd shared && .\\\\UpdateGenVersion.bat');
  patched = true;
}

if (patched) {
  fs.writeFileSync(gypPath, content);
  console.log('Patched node-pty winpty.gyp bat file paths.');
} else {
  console.log('node-pty winpty.gyp already patched.');
}
