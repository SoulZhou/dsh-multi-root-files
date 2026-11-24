// Guard the DSH-native right-sidebar tab contract. After dsh-better-sidebar was
// removed, this panel must register itself through the HOST's sidebarRightTabs
// registry + a `sidebar.right.pane.tab` slot whose key equals the definition id,
// with a `guide` entry (native start-page capsule + new-tab menu).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(dir, 'client.js'), 'utf8');

function check(name, ok) {
  if (!ok) { console.error('FAIL:', name); process.exitCode = 1; }
  else console.log('ok:', name);
}

check('no betterSidebar service dependency', !/get\(['"]betterSidebar['"]\)/.test(src));
check('no old registerTab call', !/\.registerTab\s*\(/.test(src));
check('waits for sidebarRightTabs service', /ctx\.inject\(\['sidebarRightTabs'\]/.test(src));
check('registers via tabs.register', /tabs\.register\s*\(/.test(src));
check('definition id = dsh-multi-root-files', /id:\s*['"]dsh-multi-root-files['"]/.test(src));
check("kind = 'multi-root-files'", /kind:\s*TAB_ID/.test(src) && /const TAB_ID\s*=\s*'multi-root-files'/.test(src));
check("priority 'extension'", /priority:\s*'extension'/.test(src));
check('has guide entry', /guide:\s*\[/.test(src) && /id:\s*'multi-root-files\.main'/.test(src));
check('guide has order/title/description/icon', /order:\s*26/.test(src) && /title:\s*\(\)\s*=>\s*label\(\)/.test(src) && /description:\s*\(\)\s*=>\s*description\(\)/.test(src));
check('body slot registered', /ctx\.slots\.inject\('sidebar\.right\.pane\.tab'/.test(src));
check('body slot key matches definition id', /name:\s*'sidebar\.right\.pane\.tab',\s*\n\s*key:\s*DEFINITION_ID/.test(src));
check('body adapts useTabInfo', /useTabInfo\s*=\s*props\.useTabInfo/.test(src) && /useTabInfo\(\)/.test(src));
check('body adapts useSessions for cwd', /useSessions\s*=\s*props\.useSessions/.test(src) && /byId\[sessionId\]\?\.cwd/.test(src));
check('body builds scope {sessionId,cwd}', /scope:\s*\{\s*sessionId,\s*cwd\s*\}/.test(src));
check('body renders MultiRootFilesTab', /h\(MultiRootFilesTab,\s*\{/.test(src));
check('no auto-open on boot', !/openTab\(TAB_ID/.test(src));

if (!process.exitCode) console.log('verify-native-tab: OK');
