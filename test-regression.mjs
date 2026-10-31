import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import * as rc from './lib/host.mjs';

const attention = 'Vaswani A, Shazeer N, Parmar N, et al. Attention is all you need. NeurIPS, 2017, 30: 5998-6008.';
const residual = 'He K, Zhang X, Ren S, Sun J. Deep residual learning for image recognition. CVPR, 2016, 770-778.';
const invented = 'Zhang S, Li M, et al. Underwater basket weaving in the Qing dynasty. Journal of Nonexistent Studies, 2021, 5(2): 1-9.';

function register() {
	const tools = [];
	rc.apply({ tools: { register: (tool) => tools.push(tool) } });
	return tools;
}

test('every registered tool exposes an object JSON Schema to model providers', () => {
	const tools = register();
	assert.equal(tools.length, 1);
	for (const tool of tools) {
		const schema = JSON.parse(JSON.stringify(tool.parameters));
		assert.equal(tool.name, 'reference_checker');
		assert.equal(schema.type, 'object');
		assert.equal(schema.additionalProperties, false);
		assert.deepEqual(Object.keys(schema.properties).sort(), ['maxRefs', 'path', 'references']);
		assert.equal(schema.properties.references.type, 'string');
		assert.equal(schema.properties.path.type, 'string');
		assert.equal(schema.properties.maxRefs.type, 'integer');
	}
});

test('issue #1: comma-style Vancouver citations remain separate entries', () => {
	for (const input of [
		[attention, invented].join('\n'),
		[attention, invented].join('\r\n'),
		[attention, '', invented].join('\n'),
		`References\n${attention}\n${invented}`,
	]) {
		const { refs } = rc.extractReferences(input, 'text');
		assert.equal(refs.length, 2);
		assert.equal(refs[0].line, attention);
		assert.equal(refs[1].line, invented);
	}
});

test('wrapped author lists, titles and journal clauses stay in the same entry', () => {
	const input = [
		'Vaswani A, Shazeer N,',
		'Parmar N, Uszkoreit J, et al. Attention is all',
		'you need. NeurIPS,',
		'2017, 30: 5998-6008.',
		invented,
	];
	const refs = rc.extractReferences(input.join('\n'), 'text').refs;
	assert.equal(refs.length, 2);
	assert.equal(rc.guessTitleFromLine(refs[0].line), 'Attention is all you need');
	assert.equal(refs[1].line, invented);
});

for (const [title, line] of [
	['Attention is all you need', attention],
	['Deep residual learning for image recognition', residual],
	['Underwater basket weaving in the Qing dynasty', invented],
	['Attention is all you need', 'Vaswani A, Shazeer N. Attention is all you need. NeurIPS. 2017;30:5998-6008.'],
	['Attention is all you need', 'García AB, O’Neil CDE, et al. Attention is all you need. NeurIPS, 2017, 30: 1-9.'],
	['Attention is all you need', 'Vaswani A. Attention is all you need. NeurIPS, 2017, 30: 1-9.'],
	['Attention is all you need', 'Vaswani, A., Shazeer, N. (2017). Attention is all you need. NeurIPS, 30.'],
	['Attention is all you need', 'VASWANI A, SHAZEE N. Attention is all you need[J]. NeurIPS, 2017, 30.'],
	['Attention is all you need', '[1] A. Vaswani, "Attention is all you need," in NeurIPS, 2017.'],
	['Attention is all you need', "Vaswani, A. (2017) 'Attention is all you need'. NeurIPS, 30."],
	['Attention is all you need', 'Vaswani, A. A.; Shazeer, N. Attention is all you need. Neural Inf. Process. Syst. 2017, 30, 5998-6008.'],
	['Using e.g. sparse networks for recognition', 'Smith AB, et al. Using e.g. sparse networks for recognition. Journal, 2020, 1: 1-9.'],
	['Understanding Fig. 2 in neural models', 'Smith AB, et al. Understanding Fig. 2 in neural models. Journal, 2020, 1: 1-9.'],
	['Dr. Smith Jr. and the neural model', 'Smith AB, et al. Dr. Smith Jr. and the neural model. Journal, 2020, 1: 1-9.'],
	['Comparing et al. conventions in citations', 'Comparing et al. conventions in citations. Journal, 2020, 1: 1-9.'],
]) {
	test(`extract title: ${line}`, () => {
		assert.equal(rc.guessTitleFromLine(line), title);
	});
}

test('Vancouver detection supports both journal-year separators and Unicode surnames', () => {
	for (const line of [attention, invented, 'García AB, O’Neil CDE. A useful title. Journal. 2020;1:1-9.']) {
		assert.equal(rc.detectLineFormat(line), 'vancouver');
	}
	assert.equal(rc.detectLineFormat('Some plain note about a paper without style markers at all.'), 'plain');
});

test('issue #1: execute queries clean titles and ranks real records above an unrelated DOI', async (t) => {
	const queries = [];
	const records = [
		{ title: ['Attention Is All You Need'], author: [{ family: 'Vaswani', given: 'Ashish' }], issued: { 'date-parts': [[2017]] }, DOI: '10.48550/arXiv.1706.03762' },
		{ title: ['Deep Residual Learning for Image Recognition'], author: [{ family: 'He', given: 'Kaiming' }], issued: { 'date-parts': [[2016]] }, DOI: '10.1109/CVPR.2016.90' },
		{ title: ['A review of wind turbine fault diagnosis'], author: [{ family: 'Vaswani', given: 'A' }], issued: { 'date-parts': [[2017]] }, DOI: '10.1234/unrelated' },
	];
	const request = (url, _options, callback) => {
		const req = new EventEmitter();
		req.end = () => queueMicrotask(() => {
			queries.push(new URL(url));
			const res = new PassThrough();
			res.statusCode = 200;
			res.headers = {};
			callback(res);
			res.end(url.hostname === 'api.crossref.org'
				? JSON.stringify({ message: { items: records } })
				: url.hostname === 'api.openalex.org' ? '{"results":[]}' : '<feed></feed>');
		});
		return req;
	};
	t.mock.method(http, 'request', request);
	t.mock.method(https, 'request', request);
	const [tool] = register();
	const result = await tool.execute({ references: [attention, residual, invented].join('\n') }, { signal: new AbortController().signal });
	assert.equal(result.total, 3);
	assert.deepEqual(result.summary, { found: 2, partial: 0, not_found: 1, error: 0 });
	assert.equal(result.results[0].best.title, 'Attention Is All You Need');
	assert.equal(result.results[0].score, 1);
	assert.equal(result.results[1].best.doi, '10.1109/CVPR.2016.90');
	assert.equal(result.results[1].score, 1);
	assert.equal(result.results[2].corrected, undefined);
	assert.match(result.results[0].corrected, /Attention Is All You Need/);
	const titles = ['Attention is all you need', 'Deep residual learning for image recognition', 'Underwater basket weaving in the Qing dynasty'];
	for (const title of titles) {
		assert.ok(queries.some((url) => url.hostname === 'api.crossref.org' && url.searchParams.get('query.title') === title), title);
		assert.ok(queries.some((url) => url.hostname === 'api.openalex.org' && url.searchParams.get('search') === title), title);
		assert.ok(queries.some((url) => url.hostname === 'export.arxiv.org' && url.searchParams.get('search_query') === `ti:"${title}"`), title);
	}
});
