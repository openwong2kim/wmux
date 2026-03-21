const fs = require('fs');
const path = require('path');

const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');

// Patch both winpty.gyp and binding.gyp for bat paths and SpectreMitigation
const gypFiles = [
  path.join(nodePtyDir, 'deps', 'winpty', 'src', 'winpty.gyp'),
  path.join(nodePtyDir, 'binding.gyp'),
];

let totalPatched = 0;

for (const gypPath of gypFiles) {
  if (!fs.existsSync(gypPath)) {
    continue;
  }

  let content = fs.readFileSync(gypPath, 'utf8');
  let patched = false;
  const fileName = path.basename(gypPath);

  // Fix bat file paths (winpty.gyp only)
  if (content.includes('cd shared && GetCommitHash.bat')) {
    content = content.replace('cd shared && GetCommitHash.bat', 'cd shared && .\\\\GetCommitHash.bat');
    patched = true;
  }
  if (content.includes('cd shared && UpdateGenVersion.bat')) {
    content = content.replace('cd shared && UpdateGenVersion.bat', 'cd shared && .\\\\UpdateGenVersion.bat');
    patched = true;
  }

  // Disable SpectreMitigation — requires Spectre-mitigated libraries which are
  // not included in the standard VCTools workload (--includeRecommended).
  // Without this patch, MSB8040 error occurs during electron-rebuild.
  if (content.includes("'SpectreMitigation': 'Spectre'")) {
    content = content.replace(/'SpectreMitigation': 'Spectre'/g, "'SpectreMitigation': 'false'");
    patched = true;
  }

  if (patched) {
    fs.writeFileSync(gypPath, content);
    console.log(`Patched ${fileName}`);
    totalPatched++;
  }
}

if (totalPatched === 0) {
  console.log('node-pty gyp files already patched or not found.');
}
