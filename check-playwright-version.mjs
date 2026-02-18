/**
 * Validates that Playwright version in package.json matches Docker image tag.
 */
import { readFileSync } from 'node:fs';

try {
    const dockerfileContent = readFileSync('./Dockerfile', 'utf-8');
    const packageJsonContent = readFileSync('./package.json', 'utf-8');

    const dockerMatch = dockerfileContent.match(/apify\/actor-node-playwright-(?:chrome|firefox):\d+-(\d+\.\d+\.\d+)/);
    const dockerVersion = dockerMatch ? dockerMatch[1] : null;

    const packageJson = JSON.parse(packageJsonContent);
    const packageVersion = packageJson.dependencies?.playwright;

    if (!dockerVersion) {
        console.log('WARN: Could not extract Playwright version from Dockerfile.');
        process.exit(0);
    }

    if (!packageVersion) {
        console.log('WARN: Playwright not found in package.json dependencies.');
        process.exit(0);
    }

    const cleanPackageVersion = packageVersion.replace(/^[\^~]/, '');

    if (dockerVersion !== cleanPackageVersion) {
        console.error('ERROR: Playwright version mismatch.');
        console.error(`Dockerfile: ${dockerVersion}`);
        console.error(`package.json: ${cleanPackageVersion}`);
        process.exit(1);
    }

    console.log(`OK: Playwright versions match (${dockerVersion}).`);
} catch (error) {
    console.log('WARN: Version check skipped:', error.message);
    process.exit(0);
}
