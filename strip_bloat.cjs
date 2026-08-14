const fs = require('fs');
const file = 'apps/desktop/src/renderer/App.tsx';
let content = fs.readFileSync(file, 'utf8');

// Replace imports
content = content.replace(/import \{ DreamingPanel \} from "\.\/components\/DreamingPanel";\n/, "");
content = content.replace(/import \{ applySkin, SkinSettings \} from "\.\/components\/SkinSettings";\n/, "");
content = content.replace(/import \{ FloatingPet, PetSettings \} from "\.\/components\/PetSettings";\n/, "");

// Replace PetSettings and SkinSettings
content = content.replace(/<SkinSettings status=\{skinStatus\} onChange=\{onSkinStatus\} \/>\n\s*<PetSettings status=\{petStatus\} onChange=\{onPetStatus\} \/>\n/g, "");

// Replace FloatingPet
content = content.replace(/<FloatingPet\s+status=\{petStatus\}\s+activity=\{petActivity\}\s+onOpen=\{\(\) => \{\s+setPage\("settings"\);\s+\}\}\s+onPopOut=\{\(\) => void popOutPet\(\)\}\s+\/>\n/g, "");

// Replace DreamingPanel
content = content.replace(/<DreamingPanel\s+memories=\{snapshot\.memories\}\s+onMemoryChanged=\{refreshSnapshot\}\s+\/>\n/g, "");

// Write back
fs.writeFileSync(file, content);
console.log("Stripped components");
