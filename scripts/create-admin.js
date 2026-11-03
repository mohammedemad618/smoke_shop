// Makes the admin panel's account, on the server (or your machine), in a terminal:
//   npm run admin:create                 a new admin
//   npm run admin:create -- --reset      a new password and authenticator for an existing one
// Asks for the username and the password (typed twice, never shown), then gives the
// authenticator app its secret (an otpauth:// link and the secret in groups of four, to scan
// or type in Google Authenticator or the like) and ten recovery codes, once. The admin can
// sign in only after the app's first code is typed here. Nothing is taken from the command
// line, so no password ends up in the shell's history; piped input works for automation.
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { loadConfig } from '../lib/config.js';
import { openDatabases } from '../lib/db.js';
import { adminPasswordProblem, adminUsernameProblem, createAdmin, enableTotp } from '../services/admins.js';

const USAGE = `Usage: npm run admin:create [-- --reset]

  Asks for everything on the terminal: nothing secret is ever read from the command line.
  --reset   replace the password and the authenticator of an existing admin (ends its sessions)`;

let args;
try {
  ({ values: args } = parseArgs({ options: { reset: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}\n\nThe username and the password are asked for on the terminal, never given as arguments.`);
  process.exit(1);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const interactive = process.stdin.isTTY;
const say = (text) => process.stderr.write(text);

// Lines from piped input, one per question
const piped = interactive ? null : createInterface({ input: process.stdin })[Symbol.asyncIterator]();

async function ask(question) {
  say(question);
  if (piped) {
    const { value, done } = await piped.next();
    if (done) throw new Error('Input ended before every question was answered');
    say('\n');
    return value.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => rl.question('', (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

// Read without echo: each key is taken raw, nothing is printed but the new line
async function askHidden(question) {
  if (piped) return ask(question);
  say(question);
  const { stdin } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          say('\n');
          return resolve(value);
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          say('\n');
          return reject(new Error('Cancelled'));
        }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

let db;
try {
  const config = loadConfig();
  if (!config.totpKey) {
    throw new Error('TOTP_KEY is not set. Add it to .env (development) or /etc/pos/pos.env (server): 64 hex characters, e.g. from\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  db = await openDatabases(config);
  await db.initControl();
  const ctx = { db, config };

  say(args.reset ? 'A new password and authenticator for an existing admin.\n' : 'A new admin for the admin panel.\n');
  let username;
  for (;;) {
    username = (await ask('Username (lower-case letters, digits, . _ -): ')).toLowerCase();
    const problem = adminUsernameProblem(username);
    if (!problem) break;
    say(`  ${problem}\n`);
    if (piped) throw new Error(problem);
  }
  let password;
  for (;;) {
    password = await askHidden('Password (14 characters or more, not shown): ');
    const problem = adminPasswordProblem(password, username);
    if (problem) {
      say(`  ${problem}\n`);
      if (piped) throw new Error(problem);
      continue;
    }
    if ((await askHidden('The same password again: ')) === password) break;
    say('  The two passwords are not the same\n');
    if (piped) throw new Error('The two passwords are not the same');
  }

  const made = await createAdmin(ctx, { username, password, reset: Boolean(args.reset) }, { actor: `cli:${userInfo().username}` });
  password = null;
  console.log('');
  console.log('Add it to your authenticator app (Google Authenticator, Microsoft Authenticator, 2FAS...):');
  console.log(`  link:   ${made.uri}`);
  console.log(`  or type the key by hand (time-based, 6 digits): ${made.secret}`);
  console.log('');
  console.log('Recovery codes, each works once if the phone is lost. Keep them somewhere safe, off this server:');
  for (let i = 0; i < made.recoveryCodes.length; i += 2) console.log(`  ${made.recoveryCodes[i]}    ${made.recoveryCodes[i + 1] ?? ''}`);
  console.log('');
  for (let attempt = 1; ; attempt++) {
    const code = await ask('Type the 6-digit code the app shows now, to turn the authenticator on: ');
    if (await enableTotp(ctx, made.admin._id, code)) {
      console.log(`Done: "${made.admin.username}" can sign in to the admin panel with the password and a code from the app.`);
      break;
    }
    if (attempt >= 3) {
      throw new Error('The code was not right three times. Nothing is enabled: run this again (with --reset) and check the phone\'s clock.');
    }
    say('  That code is not right (or was used already). Wait for the next one and try again.\n');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db?.close();
  // Piped input: let go of stdin, or the process waits for more lines
  if (piped) {
    await piped.return?.();
    process.stdin.destroy();
  }
}
