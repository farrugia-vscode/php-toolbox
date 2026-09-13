import { packageMentions } from './packageMentions';

/** Reads the composer.json of an installed package, null when the package is not installed. */
export type ManifestReader = (packagePath: string[]) => Promise<unknown | null>;

/** A link of the composer.json, by text offsets so it can be made without an editor. */
export type PackageLink = {
  start: number;
  end: number;
  /** A URL, or the path of the installed package's composer.json inside the vendor directory. */
  target: { url: string } | { packagePath: string[] };
  tooltip: string;
};

const PACKAGIST = 'https://packagist.org/packages/';

/** The vendor directory as composer names it, `vendor` unless the manifest moves it. */
function vendorDirectory(text: string): string {
  const match = /"vendor-dir"\s*:\s*"([^"]+)"/.exec(text);

  return match ? match[1] : 'vendor';
}

/** Where the package's code lives, as its own composer.json says: the repository first, the homepage otherwise. */
function repositoryUrl(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null) {
    return null;
  }

  const { support, homepage } = manifest as { support?: { source?: unknown }; homepage?: unknown };
  const candidates = [support?.source, homepage];

  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && /^https?:\/\//.test(candidate)) ?? null;
}

/**
 * Two links per required package: its name opens the repository, or the Packagist page
 * when nothing says where the code lives; its constraint opens the copy installed in
 * the vendor directory, when there is one.
 */
export async function packageLinks(text: string, readManifest: ManifestReader): Promise<PackageLink[]> {
  const vendor = vendorDirectory(text).split('/').filter(Boolean);
  const links: PackageLink[] = [];

  for (const mention of packageMentions(text)) {
    const packagePath = [...vendor, ...mention.name.split('/'), 'composer.json'];
    const manifest = await readManifest(packagePath);
    const repository = repositoryUrl(manifest);

    links.push({
      start: mention.nameStart,
      end: mention.nameEnd,
      target: { url: repository ?? `${PACKAGIST}${mention.name}` },
      tooltip: repository ? 'Open the repository' : 'Open on Packagist',
    });

    if (manifest !== null) {
      links.push({ start: mention.constraintStart, end: mention.constraintEnd, target: { packagePath }, tooltip: 'Open the installed package' });
    }
  }

  return links;
}
