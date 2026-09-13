import { describe, expect, test } from 'bun:test';
import { packageLinks } from '../src/composer/packageLinks';
import { packageMentions } from '../src/composer/packageMentions';

const composer = `{
    "name": "laravel/laravel",
    "require": {
        "php": "^8.3",
        "firebase/php-jwt": "^7.1",
        "laravel/framework": "^13.8"
    },
    "require-dev": {
        "laravel/pint": "^1.27"
    },
    "autoload": {
        "psr-4": { "App\\\\": "app/" }
    }
}`;

const installed: Record<string, unknown> = {
  'vendor/laravel/framework/composer.json': { homepage: 'https://laravel.com', support: { source: 'https://github.com/laravel/framework' } },
  'vendor/firebase/php-jwt/composer.json': { homepage: 'https://github.com/googleapis/php-jwt' },
};

const readInstalled = async (packagePath: string[]) => installed[packagePath.join('/')] ?? null;

describe('the packages a composer.json requires', () => {
  test('names each one with where its name and its constraint are written, skipping php and extensions', () => {
    const mentions = packageMentions(composer);

    expect(mentions.map((mention) => mention.name)).toEqual(['firebase/php-jwt', 'laravel/framework', 'laravel/pint']);
    expect(composer.slice(mentions[0].nameStart, mentions[0].nameEnd)).toBe('firebase/php-jwt');
    expect(composer.slice(mentions[0].constraintStart, mentions[0].constraintEnd)).toBe('^7.1');
    expect(composer.slice(mentions[2].constraintStart, mentions[2].constraintEnd)).toBe('^1.27');
  });

  test('links a name to the repository the installed package declares, or to its homepage', async () => {
    const links = await packageLinks(composer, readInstalled);
    const byText = (text: string) => links.find((link) => composer.slice(link.start, link.end) === text);

    expect(byText('laravel/framework')?.target).toEqual({ url: 'https://github.com/laravel/framework' });
    expect(byText('laravel/framework')?.tooltip).toBe('Open the repository');
    expect(byText('firebase/php-jwt')?.target).toEqual({ url: 'https://github.com/googleapis/php-jwt' });
  });

  test('links a name to Packagist when the package is not installed, and its constraint to the installed copy otherwise', async () => {
    const links = await packageLinks(composer, readInstalled);
    const byText = (text: string) => links.find((link) => composer.slice(link.start, link.end) === text);

    expect(byText('laravel/pint')?.target).toEqual({ url: 'https://packagist.org/packages/laravel/pint' });
    expect(byText('laravel/pint')?.tooltip).toBe('Open on Packagist');
    expect(byText('^13.8')?.target).toEqual({ packagePath: ['vendor', 'laravel', 'framework', 'composer.json'] });
    expect(byText('^1.27')).toBeUndefined();
  });

  test('looks for the installed copies where the manifest moves the vendor directory', async () => {
    const moved = composer.replace('"autoload"', '"config": { "vendor-dir": "libs/vendor" },\n    "autoload"');
    const asked: string[][] = [];

    await packageLinks(moved, async (packagePath) => {
      asked.push(packagePath);

      return null;
    });

    expect(asked[0]).toEqual(['libs', 'vendor', 'firebase', 'php-jwt', 'composer.json']);
  });
});
