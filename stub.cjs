const fs = require('fs');
const files = {
  'apps/desktop/src/renderer/components/EventApplications.tsx': `export function EventApplications(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/PetGallery.tsx': `export function PetGallery(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/PluginSettings.tsx': `export function PluginSettings(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/PetSettings.tsx': `export function FloatingPet(props: any) { return null; }\nexport function PetSettings(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/DashboardExtensions.tsx': `export function DashboardExtensions(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/PetHatch.tsx': `export function petSlug(value: string): string { return value; }\nexport function PetHatch(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/DreamingPanel.tsx': `export function DreamingPanel(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/PetOverlay.tsx': `export function PetOverlay(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/SkinSettings.tsx': `export function applySkin(skin: any): void {}\nexport function SkinSettings(props: any) { return null; }`,
  'apps/desktop/src/renderer/components/GoalKanban.tsx': `export function GoalKanban(props: any) { return null; }`
};
for (const [file, content] of Object.entries(files)) {
  fs.writeFileSync(file, content);
}
