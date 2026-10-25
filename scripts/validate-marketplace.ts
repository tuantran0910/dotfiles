import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

interface JsonObject {
	[key: string]: unknown;
}

const repositoryRoot = resolve(import.meta.dir, "..");
const defaultCatalogPath = resolve(repositoryRoot, ".omp-plugin/marketplace.json");
const catalogPath = resolve(process.argv[2] ?? defaultCatalogPath);
const namePattern = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const gitShaPattern = /^[0-9a-f]{40}$/i;
const spdxPattern = /^[A-Za-z0-9][A-Za-z0-9-.+]*(?:\s+(?:AND|OR)\s+[A-Za-z0-9][A-Za-z0-9-.+]*)*$/;
const externalSourceTypes: Record<string, true> = {
	github: true,
	url: true,
	"git-subdir": true
};
const errors: string[] = [];

function fail(location: string, message: string) {
	errors.push(`${location}: ${message}`);
}

function asObject(value: unknown): JsonObject | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as JsonObject;
}

function readJson(path: string, location: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		const object = asObject(value);
		if (!object) fail(location, "must contain a JSON object");
		return object;
	} catch (error) {
		fail(location, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

function requireString(object: JsonObject, key: string, location: string) {
	const value = object[key];
	if (typeof value !== "string" || value.length === 0) {
		fail(`${location}.${key}`, "must be a non-empty string");
		return undefined;
	}
	return value;
}

function validateName(name: string | undefined, location: string) {
	if (name && !namePattern.test(name)) {
		fail(location, "must be at most 64 lowercase letters, digits, dots, or hyphens and start and end with a letter or digit");
	}
}

function isInside(parent: string, child: string) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateLocalPlugin(entry: JsonObject, source: string, location: string, pluginRoot: string) {
	const sourcePath = resolve(repositoryRoot, pluginRoot, source);
	if (!isInside(repositoryRoot, sourcePath)) {
		fail(`${location}.source`, "must resolve inside the repository");
		return;
	}
	if (!existsSync(sourcePath)) {
		fail(`${location}.source`, `directory does not exist: ${relative(repositoryRoot, sourcePath)}`);
		return;
	}

	const packagePath = resolve(sourcePath, "package.json");
	if (!existsSync(packagePath)) {
		fail(`${location}.source`, "local plugin must contain package.json");
		return;
	}
	const packageJson = readJson(packagePath, relative(repositoryRoot, packagePath));
	if (!packageJson) return;

	const catalogName = requireString(entry, "name", location);
	const packageName = requireString(packageJson, "name", relative(repositoryRoot, packagePath));
	if (catalogName && packageName && catalogName !== packageName) {
		fail(`${location}.name`, `must match package name ${packageName}`);
	}
	if (catalogName && catalogName !== basename(sourcePath)) {
		fail(`${location}.name`, "must match the local plugin directory name");
	}
	if ("version" in entry) fail(`${location}.version`, "local plugin version belongs only in package.json");

	const version = requireString(packageJson, "version", relative(repositoryRoot, packagePath));
	if (version && !semverPattern.test(version)) {
		fail(`${relative(repositoryRoot, packagePath)}.version`, "must use semantic versioning");
	}

	const omp = asObject(packageJson.omp);
	if (!omp || omp.extensions === undefined) return;
	if (!Array.isArray(omp.extensions) || omp.extensions.some((extension) => typeof extension !== "string")) {
		fail(`${relative(repositoryRoot, packagePath)}.omp.extensions`, "must be an array of paths");
		return;
	}
	for (const [index, extension] of omp.extensions.entries()) {
		const extensionPath = resolve(sourcePath, extension);
		if (!isInside(sourcePath, extensionPath) || !existsSync(extensionPath)) {
			fail(`${relative(repositoryRoot, packagePath)}.omp.extensions[${index}]`, `does not resolve to a file inside the plugin: ${extension}`);
		}
	}
}

function validateExternalPlugin(entry: JsonObject, source: JsonObject, location: string) {
	const type = requireString(source, "source", `${location}.source`);
	if (!type || !externalSourceTypes[type]) {
		fail(`${location}.source.source`, "external source must be github, url, or git-subdir");
		return;
	}
	if (type === "github") requireString(source, "repo", `${location}.source`);
	if (type === "url" || type === "git-subdir") requireString(source, "url", `${location}.source`);
	if (type === "git-subdir") requireString(source, "path", `${location}.source`);

	const sha = requireString(source, "sha", `${location}.source`);
	if (sha && !gitShaPattern.test(sha)) fail(`${location}.source.sha`, "must be a full 40-character Git commit SHA");
	const version = requireString(entry, "version", location);
	if (version && !semverPattern.test(version)) fail(`${location}.version`, "must use semantic versioning");
	for (const field of ["repository", "homepage", "license"] as const) requireString(entry, field, location);
	const author = asObject(entry.author);
	if (!author) fail(`${location}.author`, "must be an object");
	else requireString(author, "name", `${location}.author`);
	if (typeof entry.license === "string" && !spdxPattern.test(entry.license)) {
		fail(`${location}.license`, "must use an SPDX license identifier or expression");
	}
}

const catalog = readJson(catalogPath, relative(repositoryRoot, catalogPath));
if (catalog) {
	const marketplaceName = requireString(catalog, "name", "marketplace");
	validateName(marketplaceName, "marketplace.name");
	const owner = asObject(catalog.owner);
	if (!owner) fail("marketplace.owner", "must be an object");
	else requireString(owner, "name", "marketplace.owner");

	const metadata = asObject(catalog.metadata);
	const pluginRoot = typeof metadata?.pluginRoot === "string" ? metadata.pluginRoot : "";
	if (!Array.isArray(catalog.plugins)) {
		fail("marketplace.plugins", "must be an array");
	} else {
		const names = new Set<string>();
		const readme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
		for (const [index, rawEntry] of catalog.plugins.entries()) {
			const location = `marketplace.plugins[${index}]`;
			const entry = asObject(rawEntry);
			if (!entry) {
				fail(location, "must be an object");
				continue;
			}
			const name = requireString(entry, "name", location);
			validateName(name, `${location}.name`);
			if (name) {
				if (names.has(name)) fail(`${location}.name`, `duplicate plugin name: ${name}`);
				names.add(name);
				if (!readme.includes(`\`${name}\``)) fail(`${location}.name`, "active plugin is missing from README.md");
			}

			if (typeof entry.source === "string") validateLocalPlugin(entry, entry.source, location, pluginRoot);
			else {
				const source = asObject(entry.source);
				if (source) validateExternalPlugin(entry, source, location);
				else fail(`${location}.source`, "must be a relative path or external source object");
			}
		}
	}
}

if (errors.length > 0) {
	for (const error of errors) console.error(`ERROR ${error}`);
	process.exit(1);
}

console.log(`Marketplace validation passed: ${realpathSync(catalogPath)}`);
