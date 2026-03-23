import { describe, expect, test } from "bun:test";
import { extractFilename, extractFolderName } from "@/utils/path";

describe("extractFilename", () => {
	test("extracts filename from forward-slash path", () => {
		expect(extractFilename("/home/user/docs/file.docx")).toBe("file.docx");
	});

	test("extracts filename from backslash path", () => {
		expect(extractFilename("C:\\Users\\user\\docs\\file.docx")).toBe("file.docx");
	});

	test("extracts filename from mixed separators", () => {
		expect(extractFilename("C:\\Users/user\\docs/file.docx")).toBe("file.docx");
	});

	test("returns path itself when no separators", () => {
		expect(extractFilename("file.docx")).toBe("file.docx");
	});

	test("handles trailing slash", () => {
		expect(extractFilename("/home/user/docs/")).toBe("docs");
	});
});

describe("extractFolderName", () => {
	test("extracts folder name from directory path", () => {
		expect(extractFolderName("/home/user/Doe, Jane")).toBe("Doe, Jane");
	});

	test("handles backslash paths", () => {
		expect(extractFolderName("C:\\Users\\user\\Clients\\Doe, Jane")).toBe("Doe, Jane");
	});

	test("handles trailing slash", () => {
		expect(extractFolderName("/home/user/Doe, Jane/")).toBe("Doe, Jane");
	});
});
