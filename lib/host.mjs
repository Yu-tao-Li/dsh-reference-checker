/**
 * dsh-reference-checker — 参考文献真实性检查器 (persistent, host-only Cordis plugin).
 *
 * Registers the `reference_checker` model tool. Given a paper (a file: .pdf /
 * .bib / .tex / .txt / .md / other text) or a pasted reference list, it
 * verifies every reference against public bibliographic indexes (Crossref,
 * OpenAlex, arXiv) and reports per-reference status:
 *
 *   found      — a real record with a near-identical title exists (±1 year)
 *   partial    — a plausible real record exists but details differ (⚠ check)
 *   not_found  — no close real record in any source (⚠ may be fabricated OR
 *                simply not indexed — the two cases look identical here)
 *   error      — every lookup source failed for this reference
 *
 * Document handling (v2):
 *   .pdf   → text extracted with the vendored `pdf-parse` (lazy import, so a
 *            PDF-library problem can never break preset mount); the
 *            References section is located automatically (heading scan from
 *            the end of the document).
 *   .bib   → BibTeX entries parsed directly (brace-depth scanner).
 *   .tex   → `\begin{thebibliography}` block, or the `.bib` file(s) named by
 *            `\bibliography{...}` next to the .tex file.
 *   other  → UTF-8 text (GBK fallback for Chinese Windows files); a
 *            References/Bibliography/参考文献 section is located when present,
 *            otherwise the whole input is treated as a reference list.
 *
 * Design constraints (loaded by the Cordis plugin loader from the preset
 * directory, resolved relative to the preset's own baseUrl):
 *   - ESM via the `.mjs` extension (no package.json `type` scope nearby).
 *   - No bare imports EXCEPT the vendored `pdf-parse` (its node_modules sits
 *     right next to this file, so Node resolution finds it). No @deepseek-ai
 *     imports: the user preset root is not on the DSH deployment's
 *     node_modules resolution path.
 *   - Plain JavaScript: no TypeScript, no JSX.
 *   - No service is published, so the preset row needs no isolate realm.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

export const name = 'reference-checker';
export const inject = ['tools'];

const USER_AGENT = 'dsh-reference-checker/1.1 (bibliographic verification; contact: local)';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REFS = 50;
const HARD_MAX_REFS = 200;
const REF_CONCURRENCY = 4;

const STATUS_FOUND = 'found';
const STATUS_PARTIAL = 'partial';
const STATUS_NOT_FOUND = 'not_found';
const STATUS_ERROR = 'error';

// ── result schema (the enforced JSON Schema subset) ────────────────────────

const RESULT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		total: { type: 'integer', description: 'Number of references parsed from the input.' },
		truncated: { type: 'boolean', description: 'True when the input exceeded maxRefs and only the first maxRefs were checked.' },
		source: { type: 'string', enum: ['pasted-text', 'file'], description: 'Where the references came from.' },
		extraction: {
			type: 'string',
			description: 'How references were extracted: bibtex | bibtex-via-tex | tex-bibliography | references-section | plain-lines.',
		},
		path: { type: 'string', description: 'The file path read (when source is "file").' },
		docTitle: { type: 'string', description: 'Document title from PDF metadata, when present.' },
		note: { type: 'string', description: 'Extraction note (e.g. which .bib file a .tex file pulled entries from).' },
		format: {
			type: 'string',
			description: 'Dominant detected citation style: apa | gb | ieee | vancouver | mla | bibtex | plain | mixed.',
		},
		summary: {
			type: 'object',
			additionalProperties: false,
			properties: {
				found: { type: 'integer' },
				partial: { type: 'integer' },
				not_found: { type: 'integer' },
				error: { type: 'integer' },
			},
			required: ['found', 'partial', 'not_found', 'error'],
		},
		results: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					i: { type: 'integer', description: '1-based reference number.' },
					ref: { type: 'string', description: 'The checked reference text (truncated).' },
					status: { type: 'string', enum: [STATUS_FOUND, STATUS_PARTIAL, STATUS_NOT_FOUND, STATUS_ERROR] },
					score: { type: 'number', description: 'Best-match confidence, 0..1.' },
					best: {
						oneOf: [
							{
								type: 'object',
								additionalProperties: false,
								properties: {
									source: { type: 'string' },
									title: { type: 'string' },
									year: { type: 'integer' },
									authors: { type: 'string' },
									venue: { type: 'string' },
									volume: { type: 'string' },
									issue: { type: 'string' },
									pages: { type: 'string' },
									doi: { type: 'string' },
									url: { type: 'string' },
								},
								required: ['source', 'title'],
							},
							{ type: 'null' },
						],
					},
					note: { type: 'string' },
					format: { type: 'string', description: 'Citation style detected for this reference.' },
					corrected: {
						type: 'string',
						description: 'Corrected/normalized citation built from the verified real record, in this reference\u2019s style (present for found/partial with a usable match).',
					},
					sources: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								source: { type: 'string' },
								ok: { type: 'boolean' },
								candidates: { type: 'integer' },
								error: { type: 'string' },
							},
							required: ['source', 'ok'],
						},
					},
				},
				required: ['i', 'ref', 'status'],
			},
		},
	},
	required: ['total', 'truncated', 'source', 'extraction', 'format', 'summary', 'results'],
};

// ── plugin entry ─────────────────────────────────────────────────────────────

export function apply(ctx, _config) {
	ctx.tools.register({
		name: 'reference_checker',
		description:
			'Verify that a paper\u2019s references are real publications, and provide corrected citations. Checks every reference against Crossref, OpenAlex, and arXiv, and reports per-reference status: found / partial / not_found / error, with the closest real record (title, year, venue, volume, pages, DOI/URL). For found/partial references it also emits a corrected, normalized citation in the INPUT\u2019S detected style (APA, GB/T 7714, IEEE, Vancouver, MLA, or BibTeX) under `corrected`, ready to paste back into the paper. ' +
			'Two ways to feed it: `references` = pasted text (one citation per line in any common style, or a BibTeX document); `path` = a file to read — .pdf (text layer extracted, References section located automatically), .bib, .tex (thebibliography block or the .bib named by \\bibliography), or .txt/.md/other text. For a whole paper document the references section is detected automatically. ' +
			'Use when the user asks to check/verify/validate/fix the references, bibliography, or citations of a paper, including "检查这份论文的参考文献是否真实" or "把错误的参考文献改成正确的" or when handed a paper file. ' +
			'A not_found verdict means "no close match in these indexes" — report it as such; do not claim the reference is definitely fake (old or non-indexed works, including many Chinese journals, are also missed).',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				references: {
					type: 'string',
					description: 'Pasted reference text or full document text: one citation per line, or a BibTeX document with @article/@inproceedings/... entries.',
				},
				path: {
					type: 'string',
					description:
						'Path to a file to check: .pdf, .bib, .tex, .txt, .md, or other text. For a paper file the references section is located automatically. Relative paths are resolved against the session workspace when possible, otherwise the process working directory.',
				},
				maxRefs: {
					type: 'integer',
					description: 'Optional upper bound on how many references to check (default 50, hard cap 200).',
				},
			},
		},
		output: {
			schema: RESULT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
		},
		timeoutMs: 600000,
		isConcurrencySafe: () => true,
		presentCall: (args) => {
			const p = args && typeof args.path === 'string' ? args.path : '';
			const n = countRefLines(args && args.references);
			let title = '参考文献检查';
			if (p) title = `参考文献检查 · ${p}`;
			else if (n > 0) title = `参考文献检查 (${n} 条)`;
			return {
				card: 'generic',
				title,
				kind: 'search',
				rawInput: p || String((args && args.references) || '').slice(0, 200),
			};
		},
		async execute(args, exec) {
			const textArg = typeof (args && args.references) === 'string' ? args.references.trim() : '';
			const pathArg = typeof (args && args.path) === 'string' ? args.path.trim() : '';
			if (!textArg && !pathArg) {
				throw new Error('Provide `references` (pasted text) and/or `path` (a file: .pdf/.bib/.tex/.txt/.md/...).');
			}
			const maxRefs = Number.isInteger(args && args.maxRefs) && args.maxRefs > 0
				? Math.min(args.maxRefs, HARD_MAX_REFS)
				: DEFAULT_MAX_REFS;

			let source = 'pasted-text';
			let sourcePath;
			let docTitle;
			let extractionNote;
			let extracted;

			if (pathArg) {
				source = 'file';
				sourcePath = resolveInputPath(pathArg, exec);
				const doc = loadDocument(sourcePath);
				let docText;
				if (doc.kind === 'pdf') {
					const pdf = await extractPdf(doc.buf, exec.signal);
					docText = pdf.text;
					docTitle = pdf.docTitle;
					if (!docText || !docText.trim()) {
						throw new Error('PDF 没有可提取的文本层(可能是扫描件)。请提供文本版 PDF,或直接粘贴参考文献。');
					}
				} else {
					docText = doc.text;
				}
				extracted = extractReferences(docText, doc.kind, doc.dir);
				extractionNote = extracted.note;
			} else {
				extracted = extractReferences(textArg, null, undefined);
			}

			if (extracted.refs.length === 0) {
				throw new Error(extractionNote || 'No references found in the input. For a paper document, make sure a References/Bibliography section (or BibTeX/tex bibliography) is present.');
			}
			const checked = extracted.refs.slice(0, maxRefs);
			const signal = exec && exec.signal;
			const fmtOverride = extracted.extraction === 'bibtex' || extracted.extraction === 'bibtex-via-tex'
				? 'bibtex'
				: undefined;
			const rawResults = await mapPool(checked, REF_CONCURRENCY, (ref, i) => verifyOne(ref, signal, i + 1, fmtOverride));
			const results = rawResults.map((r, idx) => withIndex(r, idx + 1));
			const summary = { found: 0, partial: 0, not_found: 0, error: 0 };
			for (const r of results) summary[r.status] += 1;
			const out = {
				total: extracted.refs.length,
				truncated: extracted.refs.length > maxRefs,
				source,
				extraction: extracted.extraction,
				format: dominantFormat(extracted, results),
				summary,
				results,
			};
			if (sourcePath) out.path = sourcePath;
			if (docTitle) out.docTitle = docTitle;
			if (extractionNote) out.note = extractionNote;
			return out;
		},
	});
}

// ── report rendering (model-facing text) ────────────────────────────────────

const EXTRACTION_LABELS = {
	bibtex: 'BibTeX 条目',
	'bibtex-via-tex': '\\bibliography 关联的 .bib 文件',
	'tex-bibliography': 'thebibliography 块',
	'references-section': '自动定位的 References 章节',
	'plain-lines': '按行解析',
};

function renderReport(value) {
	const s = value.summary;
	const lines = [];
	const via = value.source === 'file'
		? `文件 ${value.path}${value.docTitle ? ` · 文档《${value.docTitle}》` : ''}`
		: '粘贴文本';
	const how = EXTRACTION_LABELS[value.extraction] || value.extraction;
	lines.push(`参考文献检查完成:共 ${value.total} 条(${via},识别方式:${how})— ✅ found ${s.found} · ⚠️ partial ${s.partial} · ❌ not_found ${s.not_found}` +
		(s.error > 0 ? ` · ⛔ error ${s.error}` : ''));
	if (value.truncated) lines.push(`(超过上限,仅检查了前 ${value.total} 条)`);
	if (value.note) lines.push(value.note);
	lines.push('');
	lines.push('| # | 状态 | 参考文献 | 最接近的真实记录 |');
	lines.push('|---|------|----------|------------------|');
	for (const r of value.results) {
		const icon = r.status === STATUS_FOUND ? '✅' : r.status === STATUS_PARTIAL ? '⚠️' : r.status === STATUS_NOT_FOUND ? '❌' : '⛔';
		const refCell = mdCell(r.ref).slice(0, 100);
		let bestCell = '—';
		if (r.best) {
			const parts = [mdCell(r.best.title)];
			if (typeof r.best.year === 'number') parts.push(String(r.best.year));
			if (r.best.venue) parts.push(mdCell(r.best.venue));
			if (r.best.doi) parts.push(`[DOI](https://doi.org/${r.best.doi})`);
			else if (r.best.url) parts.push(`[链接](${r.best.url})`);
			bestCell = parts.join(' — ');
		} else if (r.note) {
			bestCell = mdCell(r.note);
		}
		lines.push(`| ${r.i} | ${icon} ${r.status} | ${refCell} | ${bestCell} |`);
	}
	lines.push('');
	const corrected = value.results.filter((r) => r.corrected);
	if (corrected.length > 0) {
		lines.push(`建议更正版(检出格式:${FORMAT_LABELS[value.format] || value.format};编号对应上表,可直接替换回论文):`);
		for (const r of corrected) lines.push(`${r.i}. ${r.corrected}`);
		lines.push('');
	}
	if (s.partial > 0 || s.not_found > 0) {
		lines.push('注意:partial/not_found 不等于"确定造假"——未被 Crossref/OpenAlex/arXiv 收录的出版物(老期刊、内部报告、部分中文期刊等)同样查不到。请人工点开 DOI/链接核对。');
	}
	return lines.join('\n');
}

function mdCell(s) {
	return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function countRefLines(text) {
	if (typeof text !== 'string') return 0;
	if (/@\w+\s*\{/.test(text)) return (text.match(/@\w+\s*\{/g) || []).length;
	return text.split(/\r?\n/).filter((l) => l.trim().length > 10).length;
}

// ── document loading ────────────────────────────────────────────────────────

function resolveInputPath(p, exec) {
	const candidates = [];
	if (isAbsolute(p)) candidates.push(p);
	else {
		const cwd = execCwd(exec);
		if (cwd) candidates.push(resolve(cwd, p));
		candidates.push(resolve(process.cwd(), p));
	}
	const tried = [];
	for (const c of candidates) {
		try {
			statSync(c);
			return c;
		} catch {
			tried.push(c);
		}
	}
	throw new Error('file not found: ' + p + ' (tried: ' + [...new Set(tried)].join(' ; ') + ')');
}

function execCwd(exec) {
	try {
		const a = exec && exec.agent;
		if (!a) return undefined;
		const s = a.session || a._session;
		const meta = s && (s.meta || s.header);
		if (meta && typeof meta.cwd === 'string' && meta.cwd) return meta.cwd;
	} catch {
		// best effort only
	}
	return undefined;
}

function loadDocument(absPath) {
	const ext = extname(absPath).toLowerCase();
	const buf = readFileSync(absPath);
	if (ext === '.pdf') return { kind: 'pdf', buf };
	const text = decodeTextSmart(buf);
	if (ext === '.bib') return { kind: 'bibtex', text };
	if (ext === '.tex') return { kind: 'tex', text, dir: dirname(absPath) };
	return { kind: 'text', text };
}

function decodeTextSmart(buf) {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return new TextDecoder('utf-8').decode(buf.subarray(3));
	}
	const utf8 = new TextDecoder('utf-8').decode(buf);
	if (!utf8.includes('\uFFFD')) return utf8;
	try {
		return new TextDecoder('gbk').decode(buf);
	} catch {
		return utf8;
	}
}

export function readTextSmart(absPath) {
	return decodeTextSmart(readFileSync(absPath));
}

/** Lazy import so a PDF-library problem can never break preset mount. */
async function extractPdf(buf, signal) {
	const { PDFParse } = await import('pdf-parse');
	const parser = new PDFParse({ data: new Uint8Array(buf) });
	try {
		const aborted = signal ? waitForAbort(signal) : null;
		const result = await (aborted ? Promise.race([parser.getText(), aborted.promise]) : parser.getText());
		let docTitle;
		try {
			const info = await parser.getInfo();
			const meta = (info && (info.metadata || info.info)) || {};
			const t = meta.Title || meta.title;
			if (typeof t === 'string' && t.trim()) docTitle = t.trim();
		} catch {
			// metadata is optional
		}
		return { text: String(result.text || ''), docTitle };
	} finally {
		if (aborted) aborted.dispose();
		await parser.destroy().catch(() => {});
	}
}

function waitForAbort(signal) {
	let onAbort;
	const promise = new Promise((_, reject) => {
		onAbort = () => reject(new Error('aborted'));
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	});
	return {
		promise,
		dispose: () => {
			if (signal) signal.removeEventListener('abort', onAbort);
		},
	};
}

// ── reference extraction from documents ─────────────────────────────────────

const SECTION_HEAD_RE = /^\s*(references|bibliography|works cited|cited references|参考文献|参考资料|引用文献)\s*[:：]?\s*$/i;
const NEXT_SECTION_RE = /^\s*(appendix|appendices|acknowledg|supplementary|author contributions|data availability|conflicts? of interest|disclosure)\b/i;
/** Page-separator lines that PDF text extractors (e.g. pdf-parse) inject. */
const PAGE_SEP_RE = /^\s*-{2,}\s*\d+\s+of\s+\d+\s*-{2,}\s*$/;

/**
 * Locate a References section in a whole document (PDF text, txt, md, tex
 * fallback). Scans from the END: references are the last section in a paper.
 */
export function findReferencesSection(raw) {
	const lines = String(raw || '').split(/\r?\n/);
	let start = -1;
	const horizon = Math.max(0, lines.length - 400);
	for (let i = lines.length - 1; i >= horizon; i--) {
		if (SECTION_HEAD_RE.test(lines[i])) {
			start = i + 1;
			break;
		}
	}
	if (start < 0) return null;
	const collected = [];
	for (let i = start; i < lines.length; i++) {
		if (NEXT_SECTION_RE.test(lines[i])) break;
		collected.push(lines[i]);
	}
	return { lines: collected };
}

/**
 * Split a references block (array of lines or one big string) into individual
 * references. Numbered markers ([1], (1), 1.) always start an entry; otherwise
 * a line that looks like an author lead starts a new entry when the current
 * one already looks complete.
 */
const VANCOUVER_AUTHOR_LEAD_RE = /^\p{Lu}[\p{L}'’.-]+\s+\p{Lu}{1,3}(?:\s+\p{Lu}{1,3})*\s*([,.])\s*/u;

export function splitEntries(input) {
	const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
	const entries = [];
	let cur = '';
	const push = () => {
		const line = cur.replace(/\s+/g, ' ').trim();
		if (line.length >= 10 && !PAGE_SEP_RE.test(line)) entries.push(cleanRefLine(line));
		cur = '';
	};
	for (const rawLine of lines) {
		const l = String(rawLine).replace(/\s+/g, ' ').trim();
		if (!l) {
			push();
			continue;
		}
		if (cur.length > 0 && isEntryStart(l, cur)) push();
		cur = cur ? `${cur} ${l}` : l;
	}
	push();
	return entries;
}

function isEntryStart(l, cur) {
	if (/^\[\d{1,4}\]/.test(l) || /^\(\d{1,4}\)/.test(l) || /^\d{1,4}[.)]\s/.test(l)) return true;
	// Unnumbered Vancouver entries can use commas before the year/volume.
	// An author lead is a boundary only after the preceding entry has a
	// year; otherwise it may be another line of the same wrapped author list.
	if (VANCOUVER_AUTHOR_LEAD_RE.test(l)) return /(?:19|20)\d{2}/.test(cur);
	// A line that looks like a complete reference in ANY known style starts a
	// new entry (APA "Last, F. (Year).", GB "LAST F. T[J].", Vancouver
	// "Last AA. ...", Chicago "Last, First. Year. "T""...); only plain lines
	// need the author-lead heuristic below.
	if (detectLineFormat(l) !== 'plain') return true;
	if (/^[A-Z][A-Za-zÀ-ÿ'’.-]+,?\s+(?:et al\.?|[A-Z]\.?\s)/.test(l)) return true;
	if (/^[A-Z][A-Za-zÀ-ÿ'’.-]+,?\s+\((?:19|20)\d{2}\)/.test(l)) return true;
	return false;
}

function cleanRefLine(l) {
	return l.replace(/^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)])\s+/, '');
}

function lineToRef(line) {
	const ref = { line, isBib: false };
	const ym = line.match(/(?:19|20)\d{2}/);
	if (ym) ref.year = Number(ym[0]);
	const fa = leadingAuthor(line);
	if (fa) ref.firstAuthor = fa;
	return ref;
}

function texBibliographyBlock(raw) {
	const m = String(raw || '').match(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/);
	if (!m) return null;
	const items = [];
	const re = /\\bibitem(?:\[[^\]]*\])?\s*\{[^}]*\}([\s\S]*?)(?=\\bibitem|\\end\{thebibliography\})/g;
	let bm;
	while ((bm = re.exec(m[0])) !== null) {
		const body = cleanLatex(bm[1]);
		if (body.trim().length >= 5) items.push(body.trim());
	}
	return items.length ? items : null;
}

function texBibliographyNames(raw) {
	const m = String(raw || '').match(/\\(?:bibliography|addbibresource)\s*\{([^}]+)\}/);
	if (!m) return null;
	return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract individual references from one document.
 * @param text - document text (or pasted reference list)
 * @param kind - 'pdf' | 'bibtex' | 'tex' | 'text' | null (auto)
 * @param dir - directory of the source file (for resolving .bib names)
 * @returns { refs: [{line, title?, year?, firstAuthor?, authors?, venue?, doi?, isBib}], extraction: string, note?: string }
 */
export function extractReferences(text, kind, dir) {
	const raw = String(text || '');
	const effectiveKind = kind || (/@\w+\s*\{/.test(raw) ? 'bibtex' : 'text');

	if (effectiveKind === 'bibtex') {
		const entries = parseBibtex(raw);
		if (entries.length > 0) return { refs: entriesToRefs(entries), extraction: 'bibtex' };
	}
	if (effectiveKind === 'tex') {
		const block = texBibliographyBlock(raw);
		if (block) return { refs: block.map(lineToRef), extraction: 'tex-bibliography' };
		const bibNames = texBibliographyNames(raw);
		if (bibNames && dir) {
			for (const n of bibNames) {
				for (const cand of [join(dir, `${n}.bib`), join(dir, n)]) {
					try {
						const entries = parseBibtex(readTextSmart(cand));
						if (entries.length > 0) {
							return {
								refs: entriesToRefs(entries),
								extraction: 'bibtex-via-tex',
								note: `从 ${basename(cand)} 读取 BibTeX 条目`,
							};
						}
					} catch {
						// try next candidate
					}
				}
			}
			return { refs: [], extraction: 'tex-bibliography', note: `找到 \\bibliography{${bibNames.join(', ')}} 但没有找到对应的 .bib 文件` };
		}
		// fall through: treat as plain text
	}
	const section = findReferencesSection(raw);
	if (section) {
		const refs = splitEntries(section.lines).map(lineToRef);
		if (refs.length > 0) return { refs, extraction: 'references-section' };
		return { refs: [], extraction: 'references-section', note: '定位到了 References 章节,但没有解析出任何条目' };
	}
	return { refs: splitEntries(raw).map(lineToRef), extraction: 'plain-lines' };
}

function entriesToRefs(entries) {
	return entries.map((e) => {
		const title = cleanLatex(e.fields.title || '');
		const ref = {
			line: title ? `${title} [${e.key}]` : `[${e.key}]`,
			title: title || undefined,
			authors: cleanLatex(e.fields.author || ''),
			isBib: true,
			key: e.key,
		};
		const yearMatch = String(e.fields.year || '').match(/(19|20)\d{2}/) ||
			String(e.fields.date || '').match(/(19|20)\d{2}/);
		if (yearMatch) ref.year = Number(yearMatch[0]);
		const fa = firstAuthorFrom(e.fields.author || '');
		if (fa) ref.firstAuthor = fa;
		const venue = cleanLatex(e.fields.journal || e.fields.booktitle || e.fields.publisher || e.fields.school || '');
		if (venue) ref.venue = venue;
		const doi = String(e.fields.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
		if (doi) ref.doi = doi;
		return ref;
	});
}

// ── BibTeX parsing ──────────────────────────────────────────────────────────

/** Scan `@type{ ... }` entries with brace-depth matching (braces nest in titles). */
export function parseBibtex(text) {
	const entries = [];
	let i = 0;
	while (i < text.length) {
		const at = text.indexOf('@', i);
		if (at < 0) break;
		const typeMatch = /^(\w+)/.exec(text.slice(at + 1, at + 32));
		if (!typeMatch) {
			i = at + 1;
			continue;
		}
		const type = typeMatch[1].toLowerCase();
		if (type === 'comment' || type === 'preamble') {
			const close = text.indexOf('}', at);
			i = close > 0 ? close + 1 : text.length;
			continue;
		}
		const open = text.indexOf('{', at);
		if (open < 0) break;
		let depth = 0;
		let j = open;
		for (; j < text.length; j++) {
			if (text[j] === '{') depth += 1;
			else if (text[j] === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		const body = text.slice(open + 1, j);
		const comma = body.indexOf(',');
		const key = (comma > 0 ? body.slice(0, comma) : body).trim();
		const fieldText = comma > 0 ? body.slice(comma + 1) : '';
		if (type !== 'string') entries.push({ key, fields: parseBibFields(fieldText) });
		i = j + 1;
	}
	return entries;
}

function parseBibFields(text) {
	const fields = {};
	const re = /([A-Za-z_]+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^\s,]+)/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		let v = m[2].trim();
		if (v.startsWith('{') && v.endsWith('}')) v = v.slice(1, -1);
		else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		fields[m[1].toLowerCase()] = v;
	}
	return fields;
}

function firstAuthorFrom(authors) {
	const first = String(authors || '').split(/\s+and\s+/i)[0];
	const words = first.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return undefined;
	return words[words.length - 1];
}

/** Heuristic: leading "Last, F." / "Last F." / "LAST F" author segment of a
 *  plain line (GB-style "VASWANI A," included — trailing initials are dropped). */
function leadingAuthor(line) {
	const m = String(line || '').match(/^([A-Z][A-Za-zÀ-ÿ'’.-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][A-Za-zÀ-ÿ'’.-]+){0,2})\s*[,;(]/);
	if (!m) return undefined;
	const words = m[1].split(/\s+/).filter(Boolean);
	// drop trailing single-letter initials: "VASWANI A" → "VASWANI"
	while (words.length > 1 && /^[A-Z]\.?$/.test(words[words.length - 1])) words.pop();
	return words.length > 0 ? words[words.length - 1] : undefined;
}

// ── lookup sources ──────────────────────────────────────────────────────────

function crossrefUrl(ref) {
	const q = new URLSearchParams();
	q.set('rows', '8');
	const guess = ref.title || guessTitleFromLine(ref.line);
	if (guess) {
		q.set('query.title', guess.slice(0, 300));
		if (ref.firstAuthor) q.set('query.author', ref.firstAuthor);
		else if (ref.authors) q.set('query.author', firstAuthorFrom(ref.authors) || ref.authors.slice(0, 120));
	} else {
		q.set('query.bibliographic', ref.line.slice(0, 600));
	}
	if (typeof ref.year === 'number') {
		q.set('filter', `from-pub-date:${ref.year - 1}-01-01,until-pub-date:${ref.year + 1}-12-31`);
	}
	return 'https://api.crossref.org/works?' + q.toString();
}

function openalexUrl(ref) {
	const queryText = (ref.title || guessTitleFromLine(ref.line) || ref.line).slice(0, 200);
	return 'https://api.openalex.org/works?search=' + encodeURIComponent(queryText) + '&per-page=8';
}

/** Best title available for this reference (clean bib title, else a guess). */
function refTitleForQuery(ref) {
	return ref.title || guessTitleFromLine(ref.line) || '';
}

function arxivUrl(title) {
	const clean = String(title || '').replace(/"/g, '').replace(/\.$/, '').slice(0, 200);
	return 'http://export.arxiv.org/api/query?search_query=' + encodeURIComponent(`ti:"${clean}"`) + '&max_results=6';
}

async function querySource(source, url, parse, signal) {
	let body;
	try {
		body = await httpGet(url, signal, HTTP_TIMEOUT_MS);
	} catch (err) {
		// One retry for rate-limit / transient server errors, nothing else.
		if (err && /HTTP (429|500|502|503)$/.test(err.message)) {
			await sleep(1500, signal);
			body = await httpGet(url, signal, HTTP_TIMEOUT_MS);
		} else {
			throw err;
		}
	}
	let data;
	try {
		data = JSON.parse(body);
	} catch {
		data = body; // arXiv returns Atom XML
	}
	return { source, candidates: parse(data) };
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (signal) signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('aborted'));
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

function parseCrossref(data) {
	const items = (data && data.message && data.message.items) || [];
	return items.map((it) => {
		const title = cleanLatex(String((it.title && it.title[0]) || (it['container-title'] && it['container-title'][0]) || ''));
		const authorObjs = (it.author || []).map((a) => ({ given: a.given || '', family: a.family || '' }));
		const authors = authorObjs
			.map((a) => [a.family, a.given].filter(Boolean).join(' '))
			.filter(Boolean).slice(0, 6).join(', ');
		const venue = it['container-title'] && it['container-title'][0] ? cleanLatex(String(it['container-title'][0])) : '';
		const c = { title, authors, venue, source: 'Crossref' };
		if (authorObjs.some((a) => a.given || a.family)) c.authorsList = authorObjs.slice(0, 12);
		const issued = it.issued && it.issued['date-parts'] && it.issued['date-parts'][0] && it.issued['date-parts'][0][0];
		if (issued) c.year = Number(issued);
		if (it.volume) c.volume = String(it.volume);
		if (it.issue) c.issue = String(it.issue);
		if (it.page) c.pages = String(it.page);
		if (it.DOI) {
			c.doi = String(it.DOI);
			c.url = 'https://doi.org/' + it.DOI;
		}
		return c;
	}).filter((c) => c.title);
}

function parseOpenAlex(data) {
	const results = (data && data.results) || [];
	return results.map((w) => {
		const title = cleanLatex(String(w.title || w.display_name || ''));
		const names = ((w.authorships || [])
			.map((a) => (a.author && a.author.display_name) || '')
			.filter(Boolean));
		const authors = names.slice(0, 6).join(', ');
		const venue = w.primary_location && w.primary_location.source && w.primary_location.source.display_name
			? String(w.primary_location.source.display_name)
			: '';
		const c = { title, authors, venue, source: 'OpenAlex' };
		if (names.length) c.authorsList = names.slice(0, 12).map((n) => ({ name: n }));
		if (w.publication_year) c.year = Number(w.publication_year);
		if (w.volume) c.volume = String(w.volume);
		if (w.issue) c.issue = String(w.issue);
		if (w.first_page) c.pages = w.last_page ? `${w.first_page}-${w.last_page}` : String(w.first_page);
		if (w.doi) {
			c.doi = String(w.doi).replace(/^https?:\/\/doi\.org\//i, '');
			c.url = String(w.doi);
		} else if (w.id) {
			c.url = String(w.id);
		}
		return c;
	}).filter((c) => c.title);
}

function parseArxiv(xml) {
	const out = [];
	const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
	let m;
	while ((m = entryRe.exec(xml)) !== null) {
		const b = m[1];
		const tag = (t) => {
			const r = b.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>'));
			return r ? r[1].replace(/\s+/g, ' ').trim() : '';
		};
		const id = tag('id');
		const published = (b.match(/<published>(\d{4})/) || [])[1];
		const authors = ((b.match(/<name>([\s\S]*?)<\/name>/g) || [])
			.map((s) => s.replace(/<\/?name>/g, '')).slice(0, 6).join(', '));
		const c = {
			title: decodeXml(cleanLatex(tag('title'))),
			authors,
			authorsList: ((b.match(/<name>([\s\S]*?)<\/name>/g) || []).map((s) => s.replace(/<\/?name>/g, ''))).filter(Boolean).slice(0, 12).map((n) => ({ name: decodeXml(n.trim()) })),
			venue: 'arXiv preprint',
			source: 'arXiv',
			url: id ? id.replace(/^http:/, 'https:') : undefined,
		};
		if (published) c.year = Number(published);
		out.push(c);
	}
	return out.filter((c) => c.title);
}

// ── scoring ─────────────────────────────────────────────────────────────────

/** Common English words that inflate title-containment scores for short DB
 *  titles ("All You Need Is LSD" vs a line containing "attention is all you
 *  need"). CJK tokens are never in this set, so Chinese titles are unaffected. */
const TITLE_STOPWORDS = new Set([
	'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'in', 'on',
	'for', 'to', 'and', 'or', 'by', 'with', 'at', 'from', 'as', 'it', 'its', 'this', 'that',
	'these', 'those', 'we', 'you', 'he', 'she', 'they', 'i', 'all', 'any', 'but', 'not', 'no',
	'do', 'does', 'did', 'have', 'has', 'had', 'than', 'then', 'so', 'such', 'via', 'over',
	'under', 'about', 'into', 'out', 'up', 'down', 'off', 'our', 'their', 'your', 'my',
]);

function normTokens(s) {
	const raw = String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9\u00c0-\u024f\u4e00-\u9fff]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.filter((t) => !/^(19|20)\d{2}$/.test(t));
	const filtered = raw.filter((t) => !TITLE_STOPWORDS.has(t));
	return filtered.length > 0 ? filtered : raw;
}

/**
 * Best-effort title extraction from a plain reference line, tuned per
 * citation style:
 *   GB/T 7714 "何恺明 等. 深度残差学习[J]. 计算机学报, 2016."     → "深度残差学习"
 *   IEEE/MLA/Chicago "… "Title," in Venue, 2017."               → "Title"
 *   Harvard  "Vaswani, A. (2017) 'Attention is all you need'."  → quoted title
 *   Vancouver "Vaswani A, Shazeer N. Title. Journal. 2017;30." → strip author block
 *   ACS      "Vaswani, A. A.; Shazeer, N. Title. J. 2017, 30." → strip author block
 *   APA      "Vaswani, A. et al. (2017) Attention is all you need." → after (year)
 *   plain    "He, K. et al. (2016) Deep residual... In CVPR."   → first sentence
 */
export function guessTitleFromLine(line) {
	const t0 = String(line || '').trim();
	const fmt = detectLineFormat(t0);
	// 1) GB/T 7714: the 题名 sits between the author block and the
	//    document-type marker [J]/[M]/[D]/[C]/[EB/OL]/...
	if (fmt === 'gb') {
		const m = t0.match(/^[^.\n]{0,200}?\.\s*([^\[\n]{3,200}?)\[(?:J|M|D|C|R|N|P|S|Z|CP|EB\/OL)\]\s*[.,]?\s*/);
		if (m && m[1].trim().length >= 5) return m[1].trim();
	}
	// 2) quoted title (IEEE / MLA / Chicago use double quotes)
	let m = t0.match(/["“]([^"”]{5,300})["”]/);
	if (m) {
		const q = m[1].trim().replace(/[.,;:]+$/, '');
		if (q.length >= 5) return q;
	}
	// 2b) Harvard wraps the title in single quotes
	if (fmt === 'harvard') {
		m = t0.match(/['‘]([^'’]{5,300})['’]/);
		if (m) {
			const q = m[1].trim().replace(/[.,;:]+$/, '');
			if (q.length >= 5) return q;
		}
	}
	let t = t0;
	// 3) Strip Vancouver author leads even when punctuation left the style
	// classified as plain. Stop at the final author's period, before title
	// text can be mistaken for another name.
	if (fmt === 'vancouver' || fmt === 'plain') {
		while ((m = t.match(VANCOUVER_AUTHOR_LEAD_RE))) {
			t = t.slice(m[0].length);
			if (m[1] === '.') break;
		}
	}
	// 4) ACS: strip "Last, F. F.; Last, F. F. " author block
	if (fmt === 'acs') {
		m = t.match(/^[A-Z][\w'’.-]+,?\s+[A-Z]\.+(?:\s+[A-Z]\.+)*(?:\s*;\s*[A-Z][\w'’.-]+,?\s+[A-Z]\.+(?:\s+[A-Z]\.+)*)*\s+([\s\S]*)$/);
		if (m) t = m[1];
	}
	// author-block strips can leave an "et al." fragment in front
	if (/^(?:et al\.?|et alia|and others|and co\.?)\b/i.test(t)) {
		t = t.replace(/^(?:et al\.?|et alia|and others|and co\.?)\s+/i, '');
	}
	// 5) everything after "(year)" (APA / Harvard parenthetical; APA puts a
	//    dot right after the closing paren: "(2017). Title")
	m = t.match(/^(?:\[\d{1,4}\]\s*)?[^\n]*?\((?:19|20)\d{2}\)\s*\.?\s+([A-Z][\s\S]*)$/);
	if (m) t = m[1];
	else {
		m = t.match(/^[A-Z][\w'’.-]+(?:\s+[A-Z]\.?)?(?:\s+(?:and|&)\s+[\w'’.-]+(?:\s+[A-Z]\.?)?)*,?\s+(?:(?:19|20)\d{2})[.,;:]?\s+([A-Z][\s\S]*)$/);
		if (m) t = m[1];
	}
	// trailing venue clause after a sentence end: "...recognition. In CVPR."
	t = t.replace(/\.\s*(?:In|At)\s*:\s*[A-Z][\s\S]*$/i, '.').replace(/\.\s*(?:In|At)\s+[A-Z][\s\S]*$/i, '.').trim();
	// a second trailing sentence is almost always venue/journal noise
	// ("Attention is all you need. NeurIPS.") — keep the first sentence.
	const stripped = t.replace(/\.$/, '');
	t = stripped;
	for (const boundary of stripped.matchAll(/\.\s+/g)) {
		// Abbreviations and initials inside a title are not sentence ends.
		const prefix = stripped.slice(0, boundary.index + 1);
		if (/(?:\bet al|\be\.g|\bi\.e|\bJr|\bSr|\bFig|\bFigs|\bDr|\bProf|\bvs|\bNo|\bSt|\b[A-Z])\.$/i.test(prefix)) continue;
		t = stripped.slice(0, boundary.index);
		break;
	}
	return t.length >= 10 ? t : undefined;
}

// ── citation-style detection & corrected-citation building (v3) ─────────────

export const FORMAT_LABELS = {
	apa: 'APA',
	gb: 'GB/T 7714',
	ieee: 'IEEE',
	mla: 'MLA',
	vancouver: 'Vancouver/AMA',
	chicago: 'Chicago',
	harvard: 'Harvard',
	acs: 'ACS',
	bibtex: 'BibTeX',
	plain: '通用',
	mixed: '混合',
};

/**
 * Detect the citation style of one reference line. The label is advisory
 * (it picks the corrected-citation template), so heuristics stay loose but
 * are ordered so unambiguous signals win:
 *   GB      → document-type marker [J]/[M]/[D]/... (unique to GB/T 7714)
 *   IEEE    → [n] numbered item with initials + quoted title, or "..." , in ...
 *   APA     → "Last, F., ... (Year). Title"
 *   Harvard → "Last, F. (Year) 'Title'"
 *   Chicago → "Last, First, et al. Year. "Title""
 *   Vancouver → "Last AA. ... Year;Vol:"
 *   MLA     → "Last, First. "Title"" (no year before the quote)
 *   ACS     → semicolon-separated authors + "Journal Abr. Year, Vol, pages"
 */
export function detectLineFormat(line) {
	const l = String(line || '');
	if (/\[(?:J|M|D|C|R|N|P|S|Z|CP|EB\/OL)\]\s*[.,]/.test(l) || /(^|\s)\/(J|M|D|C)\b/.test(l)) return 'gb';
	if (/^\[?\d{1,4}\]\s*[A-Z]\.\s+[\w'’-]+\s*,?\s*"/.test(l)) return 'ieee';
	if (/"[^"]{5,}"\s*,?\s*(?:in|in:)\s+[A-Z]/.test(l)) return 'ieee';
	if (/^[A-Z][\w'’.-]+,\s[A-Z]\.?\s*[,;]?\s*[\s\S]*?\((?:19|20)\d{2}\)\s*\.?\s*[A-Z]/.test(l)) return 'apa';
	if (/^[A-Z][\w'’-]+,?\s+[A-Z]\.?\s*\((?:19|20)\d{2}\)\s*['‘“"]\s*/.test(l)) return 'harvard';
	if (/^[A-Z][\w'’-]+,\s[A-Z][\w'’-]*[\s\S]*?\.{0,2}\s*(?:19|20)\d{2}\.\s*["“]/.test(l)) return 'chicago';
	if (VANCOUVER_AUTHOR_LEAD_RE.test(l) && /\b(?:19|20)\d{2}\s*[;,]\s*\d/.test(l)) return 'vancouver';
	if (/^[A-Z][\w'’-]+,\s[A-Z][\w'’-]*(?:\s*,?\s+and\s+[A-Z][\w'’-]*\s+[A-Z][\w'’-]*)?\.\s*["“]/.test(l)) return 'mla';
	if (/^[A-Z][\w'’.-]+,?\s+[A-Z]\.+(?:\s+[A-Z]\.)*(;\s+[A-Z][\w'’.-]+,?\s+[A-Z]\.+(?:\s+[A-Z]\.+)*)+\s+[\s\S]*\.\s*(?:19|20)\d{2},\s*\d+/.test(l)) return 'acs';
	return 'plain';
}

/** [family, given] from a structured author ({given, family}) or {name}.
 *  For unstructured name strings ("Aidan N. Gomez", "Ashish Vaswani") the
 *  LAST token is the family name — the common case for feeds that return
 *  "Given [Middle] Family". */
function splitName(a) {
	if (!a) return ['', ''];
	if (a.family) return [a.family, a.given || ''];
	const parts = String(a.name || '').split(/\s+/).filter(Boolean);
	if (parts.length === 1) return [parts[0], ''];
	return [parts[parts.length - 1], parts.slice(0, -1).join(' ')];
}

function initials(given) {
	return String(given || '')
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase())
		.join('');
}

function apaAuthor(a) {
	const [f, g] = splitName(a);
	const inits = g.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join(' ');
	return inits ? `${f}, ${inits}` : f;
}
function apaAuthors(list) {
	if (!list.length) return '';
	const arr = list.map(apaAuthor);
	if (arr.length === 1) return arr[0];
	return arr.slice(0, -1).join(', ') + ', & ' + arr[arr.length - 1];
}
function ieeeAuthor(a) {
	const [f, g] = splitName(a);
	const inits = g.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join(' ');
	return inits ? `${inits} ${f}` : f;
}
function vanAuthor(a) {
	const [f, g] = splitName(a);
	return g ? `${f} ${initials(g)}` : f;
}
function gbAuthor(a) {
	const [f, g] = splitName(a);
	return g ? `${f} ${initials(g)}` : f;
}
function mlaAuthors(list) {
	if (!list.length) return '';
	const full = list.map((a) => {
		const [f, g] = splitName(a);
		return g ? `${f}, ${g}` : f;
	});
	if (full.length >= 3) return `${full[0]}, et al.`;
	return full.length === 2 ? `${full[0]} and ${full[1]}` : full[0];
}
function chicagoAuthors(list) {
	if (!list.length) return '';
	const full = list.map((a) => {
		const [f, g] = splitName(a);
		return g ? `${f}, ${g}` : f;
	});
	if (full.length >= 3) return `${full[0]}, et al`; // template adds the period
	if (full.length === 2) return `${full[0]}, and ${full[1]}`;
	return full[0];
}
function acsAuthor(a) {
	const [f, g] = splitName(a);
	const inits = g.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join(' ');
	return inits ? `${f}, ${inits}` : f;
}
function harvardAuthors(list) {
	if (!list.length) return '';
	const arr = list.map(apaAuthor);
	if (arr.length === 1) return arr[0];
	return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
}

/**
 * Build a corrected/normalized citation from a verified real record, in the
 * reference's detected style. Missing fields degrade gracefully.
 * @param rec  - {title, year?, authorsList?, authors?, venue?, doi?, url?, volume?, issue?, pages?, key?}
 * @param format - 'apa' | 'gb' | 'ieee' | 'vancouver' | 'mla' | 'bibtex' | 'plain'
 * @param index  - 1-based reference number (used by IEEE)
 */
export function formatCitation(rec, format, index) {
	const title = rec.title || '';
	const year = typeof rec.year === 'number' ? String(rec.year) : '';
	const venue = rec.venue || '';
	const doi = rec.doi || '';
	const vol = rec.volume || '';
	const iss = rec.issue || '';
	const pages = rec.pages || '';
	const doiPart = doi ? `https://doi.org/${doi}` : rec.url || '';
	let list = rec.authorsList;
	if ((!list || !list.length) && rec.authors) {
		list = String(rec.authors).split(',').map((s) => ({ name: s.trim() })).filter((a) => a.name);
	}
	list = (list || []).slice(0, 12);

	if (format === 'gb') {
		let s = `${list.map(gbAuthor).join(', ')}. ${title}[J]. `;
		if (venue) s += `${venue}, `;
		if (year) s += year;
		if (vol) s += `, ${vol}`;
		if (iss) s += `(${iss})`;
		if (pages) s += `: ${pages}`;
		s += '.';
		if (doiPart) s += ` ${doiPart}.`;
		return s;
	}
	if (format === 'ieee') {
		const parts = [];
		if (venue) parts.push(venue);
		if (vol) parts.push(`vol. ${vol}`);
		if (iss) parts.push(`no. ${iss}`);
		if (pages) parts.push(`pp. ${pages}`);
		let s = `[${index}] ${list.map(ieeeAuthor).join(', ')}, "${title}," `;
		if (parts.length) s += parts.join(', ');
		s += year ? `${parts.length ? ',' : ''} ${year}.` : '.';
		if (doi) s += ` doi: ${doi}.`;
		return s;
	}
	if (format === 'vancouver') {
		let s = `${list.map(vanAuthor).join(', ')}. ${title}. `;
		if (venue) s += `${venue}. `;
		s += year;
		if (vol) s += `;${vol}`;
		if (iss) s += `(${iss})`;
		if (pages) s += `:${pages}`;
		s += '.';
		if (doi) s += ` doi: ${doi}.`;
		return s;
	}
	if (format === 'mla') {
		let s = `${mlaAuthors(list)}. "${title}." `;
		if (venue) s += `${venue}, `;
		if (year) s += year;
		s += '.';
		if (doiPart) s += ` ${doiPart}`;
		return s;
	}
	if (format === 'chicago') {
		let s = `${chicagoAuthors(list)}. ${year}. "${title}." `;
		if (venue) s += venue;
		if (vol) s += ` ${vol}`;
		if (pages) s += `: ${pages}`;
		s += '.';
		if (doiPart) s += ` ${doiPart}`;
		return s;
	}
	if (format === 'harvard') {
		let s = `${harvardAuthors(list)} (${year}) '${title}'. `;
		if (venue) s += venue;
		if (vol) s += `, ${vol}`;
		if (pages) s += `, pp. ${pages}`;
		s += '.';
		if (doi) s += ` doi:${doi}`;
		return s;
	}
	if (format === 'acs') {
		let s = `${list.map(acsAuthor).join('; ')} ${title}. `;
		if (venue) s += `${venue} `;
		s += year;
		if (vol) s += `, ${vol}`;
		if (pages) s += `, ${pages}`;
		s += '.';
		if (doi) s += ` DOI: ${doi}.`;
		return s;
	}
	if (format === 'bibtex') {
		const isProc = /proceedings|conference|workshop|symposium/i.test(venue);
		const type = isProc ? 'inproceedings' : 'article';
		const bibAuthors = list.map((a) => {
			const [f, g] = splitName(a);
			return g ? `${f} ${g}` : f;
		}).join(' and ');
		let s = `@${type}{${rec.key || 'ref'},\n  title = {${title}},\n  author = {${bibAuthors}}`;
		if (year) s += `,\n  year = {${year}}`;
		if (venue) s += `,\n  ${isProc ? 'booktitle' : 'journal'} = {${venue}}`;
		if (vol) s += `,\n  volume = {${vol}}`;
		if (doi) s += `,\n  doi = {${doi}}`;
		return s + '\n}';
	}
	// apa (also the fallback for 'plain')
	let s = `${apaAuthors(list)} (${year}). ${title}. `;
	if (venue) {
		s += venue;
		if (vol) s += `, ${vol}`;
		if (iss) s += `(${iss})`;
		if (pages) s += `, ${pages}`;
		s += '.';
	}
	if (doiPart) s += ` ${doiPart}`;
	return s.trim();
}

export function titleSimilarity(dbTitle, refText, refTitleKnown) {
	const dbSet = new Set(normTokens(dbTitle));
	const refSet = new Set(normTokens(refText));
	if (dbSet.size === 0 || refSet.size === 0) return 0;
	let inter = 0;
	for (const t of dbSet) if (refSet.has(t)) inter += 1;
	const jaccard = inter / (dbSet.size + refSet.size - inter);
	const [small, big] = dbSet.size <= refSet.size ? [dbSet, refSet] : [refSet, dbSet];
	let covered = 0;
	for (const t of small) if (big.has(t)) covered += 1;
	const containment = covered / small.size;
	// For plain lines we don't own a clean title, so "the DB title's tokens
	// mostly appear in the line" (containment) is the meaningful metric.
	return refTitleKnown ? Math.max(jaccard, 0.5 * jaccard + 0.5 * containment) : containment;
}

export function scoreCandidate(cand, ref) {
	const t = titleSimilarity(cand.title, ref.title || ref.line, Boolean(ref.title));
	let yearFactor = 1;
	if (typeof ref.year === 'number' && typeof cand.year === 'number') {
		const d = Math.abs(ref.year - cand.year);
		yearFactor = d <= 1 ? 1 : d === 2 ? 0.5 : 0;
	}
	let authorFactor = 1;
	let authorMiss = false;
	if (ref.firstAuthor) {
		const surname = (normTokens(ref.firstAuthor).pop()) || '';
		const hay = String(cand.authors || '').toLowerCase();
		let hit = false;
		if (surname.length >= 2 && !/^\d+$/.test(surname)) {
			// word-boundary match: "He" matches "He Kaiming" but "Li" does not
			// match "Alice"
			try {
				hit = new RegExp('\\b' + surname.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(hay);
			} catch {
				hit = hay.includes(surname.toLowerCase());
			}
		}
		// Only a definite miss on a candidate that DOES carry author info
		// disqualifies a "found" verdict; records without author metadata
		// cannot be judged.
		authorMiss = hay.length > 0 && !hit;
		authorFactor = hit ? 1 : 0;
		if (!ref.title) authorFactor = 0.5 * authorFactor + 0.5; // heuristic author: soften
	}
	const score = 0.72 * t + 0.18 * yearFactor + 0.1 * authorFactor;
	return { t, yearFactor, authorFactor, authorMiss, score };
}

// ── verification ────────────────────────────────────────────────────────────

async function verifyOne(ref, signal, index, fmtOverride) {
	const base = { ref: ref.line.slice(0, 240) };
	if (ref.isBib && !ref.title) {
		return { ...base, status: STATUS_ERROR, note: 'BibTeX 条目缺少 title 字段,无法核对' };
	}
	const jobs = [
		{ source: 'Crossref', run: () => querySource('Crossref', crossrefUrl(ref), parseCrossref, signal) },
		{ source: 'OpenAlex', run: () => querySource('OpenAlex', openalexUrl(ref), parseOpenAlex, signal) },
	];
	const arxivTitle = refTitleForQuery(ref);
	if (arxivTitle) jobs.push({ source: 'arXiv', run: () => querySource('arXiv', arxivUrl(arxivTitle), parseArxiv, signal) });
	const settled = await Promise.allSettled(jobs.map((j) => j.run()));
	const candidates = [];
	const sources = [];
	settled.forEach((s, idx) => {
		if (s.status === 'fulfilled') {
			candidates.push(...s.value.candidates);
			sources.push({ source: s.value.source, ok: true, candidates: s.value.candidates.length });
		} else {
			const entry = { source: jobs[idx].source, ok: false };
			const msg = s.reason && s.reason.message ? s.reason.message : String(s.reason);
			entry.error = msg;
			sources.push(entry);
		}
	});
	if (candidates.length === 0) {
		if (sources.every((s) => !s.ok)) {
			return {
				...base,
				status: STATUS_ERROR,
				sources,
				note: '所有数据源均失败: ' + sources.map((s) => `${s.source}(${s.error})`).join('; '),
			};
		}
		return { ...base, status: STATUS_NOT_FOUND, score: 0, sources };
	}
	let best = null;
	for (const c of candidates) {
		const sc = scoreCandidate(c, ref);
		if (!best || sc.score > best.score) best = { cand: c, ...sc };
	}
	const yearGap = typeof ref.year === 'number' && typeof best.cand.year === 'number'
		? Math.abs(ref.year - best.cand.year)
		: 0;
	const yearDisqualified = yearGap >= 3;
	// "found" is deliberately strict: strong title overlap on BOTH sides,
	// plausible year, and (when the candidate carries author info and the
	// reference line names a first author) the author must match.
	const isFound = best.score >= 0.8 && best.t >= 0.75 && !yearDisqualified && !best.authorMiss;
	const status = isFound
		? STATUS_FOUND
		: best.t >= 0.55
			? STATUS_PARTIAL
			: STATUS_NOT_FOUND;
	const bestOut = { source: best.cand.source, title: best.cand.title };
	if (typeof best.cand.year === 'number') bestOut.year = best.cand.year;
	if (best.cand.authors) bestOut.authors = best.cand.authors;
	if (best.cand.venue) bestOut.venue = best.cand.venue;
	if (best.cand.volume) bestOut.volume = best.cand.volume;
	if (best.cand.issue) bestOut.issue = best.cand.issue;
	if (best.cand.pages) bestOut.pages = best.cand.pages;
	if (best.cand.doi) bestOut.doi = best.cand.doi;
	if (best.cand.url) bestOut.url = best.cand.url;
	const out = {
		...base,
		status,
		score: Math.round(best.score * 100) / 100,
		best: bestOut,
		sources,
	};
	if (status !== STATUS_FOUND && yearDisqualified) {
		out.note = `年份差异 ${yearGap} 年,请人工核对`;
	}
	// Corrected citation in the input's style, for every verdict with a
	// usable real record (found + partial with a decent title match).
	const fmt = fmtOverride || detectLineFormat(ref.line);
	out.format = fmt;
	if ((status === STATUS_FOUND || status === STATUS_PARTIAL) && best.t >= 0.55) {
		out.corrected = formatCitation({ ...best.cand, key: ref.key }, fmt === 'plain' ? 'apa' : fmt, index);
	}
	return out;
}

function withIndex(r, i) {
	const out = { i };
	for (const [k, v] of Object.entries(r)) if (v !== undefined) out[k] = v;
	return out;
}

/** Dominant citation style across the extracted references. */
function dominantFormat(extracted, results) {
	if (extracted.extraction === 'bibtex' || extracted.extraction === 'bibtex-via-tex') return 'bibtex';
	if (results.length === 0) return 'plain';
	const counts = {};
	for (const r of results) {
		const f = r.format || 'plain';
		counts[f] = (counts[f] || 0) + 1;
	}
	let top = 0;
	let topFmt = 'plain';
	for (const [f, c] of Object.entries(counts)) {
		if (c > top) {
			top = c;
			topFmt = f;
		}
	}
	if (topFmt !== 'plain' && top * 2 >= results.length) return topFmt;
	if (topFmt === 'plain' && top === results.length) return 'plain';
	return 'mixed';
}

async function mapPool(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const i = next;
			next += 1;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

// ── HTTP helper (node: builtins only, follows up to 3 redirects) ────────────

function httpGet(urlStr, signal, timeoutMs) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const fail = (err) => {
			if (!settled) {
				settled = true;
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		};
		const ok = (v) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		const cleanup = () => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', onAbort);
		};
		const onAbort = () => fail(new Error('aborted'));
		const timer = setTimeout(() => fail(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
		if (signal) {
			if (signal.aborted) {
				cleanup();
				fail(new Error('aborted'));
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
		let hops = 0;
		const go = (u) => {
			let u2;
			try {
				u2 = new URL(u);
			} catch (e) {
				cleanup();
				fail(e);
				return;
			}
			const lib = u2.protocol === 'http:' ? http : https;
			const req = lib.request(u2, {
				method: 'GET',
				headers: {
					'User-Agent': USER_AGENT,
					Accept: 'application/json, application/xml;q=0.9, */*;q=0.8',
					'Accept-Language': 'en',
				},
			}, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
					res.resume();
					hops += 1;
					let target;
					try {
						target = new URL(res.headers.location, u2).toString();
					} catch (e) {
						cleanup();
						fail(e);
						return;
					}
					go(target);
					return;
				}
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => {
					cleanup();
					if (res.statusCode < 200 || res.statusCode >= 300) {
						fail(new Error(`HTTP ${res.statusCode}`));
						return;
					}
					ok(Buffer.concat(chunks).toString('utf8'));
				});
				res.on('error', (e) => {
					cleanup();
					fail(e);
				});
			});
			req.on('error', (e) => {
				cleanup();
				fail(e);
			});
			req.end();
		};
		go(urlStr);
	});
}

// ── text helpers ────────────────────────────────────────────────────────────

function cleanLatex(s) {
	return String(s || '')
		.replace(/\{([^{}]*)\}/g, '$1')
		.replace(/\$[^$]*\$/g, ' ')
		.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, ' ')
		.replace(/[\\{}]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function decodeXml(s) {
	return String(s)
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
}
