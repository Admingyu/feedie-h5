#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "client");
const h5Page = path.join(output, "h5.html");

if (!existsSync(h5Page)) throw new Error("Missing H5 page: dist/client/h5.html");

copyFileSync(h5Page, path.join(output, "index.html"));
console.log("Prepared H5 app entry: dist/client/index.html");
