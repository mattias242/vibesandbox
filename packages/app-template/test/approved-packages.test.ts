/**
 * ADR 0001: allowlisten är mallens package.json, och paketkatalogen ska stämma med den.
 * Det här testet är "CI stoppar om katalogen och package.json inte stämmer överens".
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface ApprovedPackage {
  name: string;
  version: string;
  kind: 'dependency' | 'devDependency';
  purpose: string;
  license: string;
  reviewedBy: string;
  reviewedAt: string;
  rationale: string;
}

interface Catalogue {
  platformPackages: string[];
  packages: ApprovedPackage[];
}

interface Manifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

const templateDir = new URL('../', import.meta.url);

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, templateDir), 'utf8')) as T;
}

const manifest = await readJson<Manifest>('package.json');
const catalogue = await readJson<Catalogue>('approved-packages.json');

/** Licenser som ADR 0001 räknar som förenliga med EUPL-1.2. */
const COMPATIBLE_LICENSES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', '0BSD']);

function thirdParty(section: Record<string, string>): [string, string][] {
  return Object.entries(section).filter(([name]) => !catalogue.platformPackages.includes(name));
}

describe('mallens paketkatalog (ADR 0001)', () => {
  it('varje tredjepartsberoende har en exakt version — inga intervall, taggar, adresser eller sökvägar', () => {
    const all = [...thirdParty(manifest.dependencies), ...thirdParty(manifest.devDependencies)];
    expect(all.length).toBeGreaterThan(0);
    for (const [name, version] of all) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('plattformens egna paket är just plattformens', () => {
    for (const name of catalogue.platformPackages) {
      expect(name).toMatch(/^@vibesandbox\//);
    }
  });

  it('katalogen och package.json listar exakt samma paket, med samma version och slag', () => {
    const fromManifest = [
      ...thirdParty(manifest.dependencies).map(([name, version]) => `${name}@${version} dependency`),
      ...thirdParty(manifest.devDependencies).map(([name, version]) => `${name}@${version} devDependency`),
    ].sort();
    const fromCatalogue = catalogue.packages.map((entry) => `${entry.name}@${entry.version} ${entry.kind}`).sort();
    expect(fromCatalogue).toEqual(fromManifest);
  });

  it('varje post har syfte, förenlig licens, granskare, datum och motivering', () => {
    for (const entry of catalogue.packages) {
      expect(entry.purpose.length, `${entry.name}: syfte`).toBeGreaterThan(10);
      expect(entry.rationale.length, `${entry.name}: motivering`).toBeGreaterThan(20);
      expect(COMPATIBLE_LICENSES.has(entry.license), `${entry.name}: licensen ${entry.license}`).toBe(true);
      expect(entry.reviewedBy.length, `${entry.name}: granskare`).toBeGreaterThan(0);
      expect(entry.reviewedAt, `${entry.name}: datum`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('mallen har inga livscykelskript som npm kör av sig självt', () => {
    const automatic = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack'];
    for (const name of automatic) {
      expect(manifest.scripts[name], name).toBeUndefined();
    }
  });
});
