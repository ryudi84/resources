import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { Grail } from './types.ts';

/**
 * Watchlist CLI — add, list, remove, pause and resume grails.
 *
 *   npm run grail:add -- --name "Kato Workhorse Gyuto 240" --all kato --all gyuto --any 240 --none petty --max-price 2000
 *   npm run grail:list
 *   npm run grail -- pause kato-workhorse-gyuto-240
 *   npm run grail -- resume kato-workhorse-gyuto-240
 *   npm run grail:remove -- kato-workhorse-gyuto-240
 */

const FILE = 'grails.json';

interface GrailFile {
  $comment?: string;
  grails: Grail[];
}

async function load(): Promise<GrailFile> {
  return JSON.parse(await readFile(FILE, 'utf8')) as GrailFile;
}

async function save(data: GrailFile): Promise<void> {
  await writeFile(FILE, JSON.stringify(data, null, 2) + '\n');
}

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function describe(g: Grail): string {
  const parts: string[] = [];
  if (g.match.all?.length) parts.push(`all of [${g.match.all.join(', ')}]`);
  if (g.match.any?.length) parts.push(`any of [${g.match.any.join(', ')}]`);
  if (g.match.none?.length) parts.push(`none of [${g.match.none.join(', ')}]`);
  if (g.priceMax != null) parts.push(`≤ ${g.priceMax}`);
  if (g.retailers?.length) parts.push(`@ ${g.retailers.join(', ')}`);
  return parts.join(' · ');
}

async function cmdAdd(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      all: { type: 'string', multiple: true },
      any: { type: 'string', multiple: true },
      none: { type: 'string', multiple: true },
      'max-price': { type: 'string' },
      retailer: { type: 'string', multiple: true },
      notes: { type: 'string' },
      id: { type: 'string' },
    },
  });
  if (!values.name) {
    console.error('Usage: npm run grail:add -- --name "Kato Workhorse Gyuto 240" --all kato --all gyuto [--any 240] [--none petty] [--max-price 2000] [--retailer tosho]');
    process.exitCode = 1;
    return;
  }
  if (!values.all?.length && !values.any?.length) {
    console.error('Give at least one --all or --any term, or the grail would never match anything.');
    process.exitCode = 1;
    return;
  }
  const data = await load();
  const id = values.id ?? slugify(values.name);
  if (data.grails.some((g) => g.id === id)) {
    console.error(`A grail with id "${id}" already exists. Pass --id to pick another.`);
    process.exitCode = 1;
    return;
  }
  const grail: Grail = {
    id,
    name: values.name,
    match: {
      ...(values.all?.length ? { all: values.all } : {}),
      ...(values.any?.length ? { any: values.any } : {}),
      ...(values.none?.length ? { none: values.none } : {}),
    },
    ...(values['max-price'] ? { priceMax: Number.parseFloat(values['max-price']) } : {}),
    ...(values.retailer?.length ? { retailers: values.retailer } : {}),
    ...(values.notes ? { notes: values.notes } : {}),
  };
  data.grails.push(grail);
  await save(data);
  console.log(`Added grail "${grail.name}" (${grail.id}): ${describe(grail)}`);
}

async function cmdList(): Promise<void> {
  const data = await load();
  if (data.grails.length === 0) {
    console.log('No grails yet. Add one with npm run grail:add');
    return;
  }
  for (const g of data.grails) {
    const state = g.enabled === false ? '⏸' : '◈';
    console.log(`${state} ${g.id}\n    ${g.name}\n    ${describe(g)}${g.notes ? `\n    ${g.notes}` : ''}`);
  }
}

async function cmdRemove(id: string | undefined): Promise<void> {
  if (!id) {
    console.error('Usage: npm run grail:remove -- <grail-id>');
    process.exitCode = 1;
    return;
  }
  const data = await load();
  const before = data.grails.length;
  data.grails = data.grails.filter((g) => g.id !== id);
  if (data.grails.length === before) {
    console.error(`No grail with id "${id}". Run npm run grail:list to see ids.`);
    process.exitCode = 1;
    return;
  }
  await save(data);
  console.log(`Removed grail "${id}".`);
}

async function cmdSetEnabled(id: string | undefined, enabled: boolean): Promise<void> {
  if (!id) {
    console.error(`Usage: npm run grail -- ${enabled ? 'resume' : 'pause'} <grail-id>`);
    process.exitCode = 1;
    return;
  }
  const data = await load();
  const grail = data.grails.find((g) => g.id === id);
  if (!grail) {
    console.error(`No grail with id "${id}". Run npm run grail:list to see ids.`);
    process.exitCode = 1;
    return;
  }
  if (enabled) delete grail.enabled;
  else grail.enabled = false;
  await save(data);
  console.log(`${enabled ? 'Resumed' : 'Paused'} grail "${id}".`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'add':
    await cmdAdd(rest);
    break;
  case 'list':
  case undefined:
    await cmdList();
    break;
  case 'remove':
    await cmdRemove(rest[0]);
    break;
  case 'pause':
    await cmdSetEnabled(rest[0], false);
    break;
  case 'resume':
    await cmdSetEnabled(rest[0], true);
    break;
  default:
    console.error(`Unknown command "${command}". Commands: add, list, remove, pause, resume`);
    process.exitCode = 1;
}
