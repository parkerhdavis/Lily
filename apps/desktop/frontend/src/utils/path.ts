/**
 * Shared path utilities for cross-platform filename/folder extraction.
 * Normalizes Windows backslashes to forward slashes before splitting.
 */

/** Extract the final segment (filename) from a file path. */
export function extractFilename(path: string): string {
	return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

/** Extract the parent folder name from a directory path. */
export function extractFolderName(path: string): string {
	return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}
