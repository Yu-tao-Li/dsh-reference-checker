// End-to-end test of the refcheck tool: multi-format parsing, corrected
// citations, and live Crossref/OpenAlex/arXiv lookups. Run:  node e2e-test.mjs
import * as rc from './lib/host.mjs';

let toolDef;
rc.apply({ tools: { register: (d) => { toolDef = d; } } });
console.log('tool registered:', toolDef.name);

// 鈹€鈹€ offline: style detection + corrected-citation templates 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const cases = [
	['gb', 'VASWANI A, SHAZEE N. Attention is all you need[J]. NeurIPS, 2017, 30.'],
	['apa', 'Vaswani, A., Shazeer, N. (2017). Attention is all you need. NeurIPS, 30.'],
	['ieee', '[1] A. Vaswani, "Attention is all you need," in NeurIPS, 2017.'],
	['vancouver', 'Vaswani A, Shazeer N, Parmar N. Attention is all you need. NeurIPS. 2017;30:5998-6008.'],
	['chicago', 'Vaswani, Ashish, et al. 2017. "Attention Is All You Need." NeurIPS 30.'],
	['harvard', "Vaswani, A. (2017) 'Attention is all you need'. NeurIPS, 30."],
	['mla', 'Vaswani, Ashish, and Noam Shazeer. "Attention Is All You Need." NeurIPS, 2017.'],
	['acs', 'Vaswani, A. A.; Shazeer, N. Attention is all you need. Neural Inf. Process. Syst. 2017, 30, 5998-6008.'],
	['plain', 'Some plain note about a paper without style markers at all.'],
];
let offlineFail = 0;
for (const [want, line] of cases) {
	const got = rc.detectLineFormat(line);
	const ok = got === want;
	if (!ok) offlineFail++;
	console.log(`detect ${ok ? 'OK ' : 'FAIL'} want=${want} got=${got}  ${line.slice(0, 50)}`);
}

const rec = {
	title: 'Attention Is All You Need', year: 2017, venue: 'NeurIPS', volume: '30', pages: '5998-6008',
	doi: '10.48550/arXiv.1706.03762',
	authorsList: [{ family: 'Vaswani', given: 'Ashish' }, { family: 'Shazeer', given: 'Noam' }],
	key: 'vaswani2017',
};
console.log('\ncorrected templates:');
for (const f of ['apa', 'gb', 'ieee', 'vancouver', 'mla', 'chicago', 'harvard', 'acs', 'bibtex']) {
	console.log(`  [${f}] ${rc.formatCitation(rec, f, 1).replace(/\n/g, ' ')}`);
}

// regression: multi-word given name ("Aidan N. Gomez") must split with the
// LAST token as family → "Gomez, A. N." (APA) / "Gomez AN" (GB), not "N. Gomez, A."
const mwRec = {
	title: 'Attention Is All You Need', year: 2017, venue: 'NeurIPS',
	authorsList: [{ name: 'Aidan N. Gomez' }, { name: 'Ashish Vaswani' }],
};
const mwApa = rc.formatCitation(mwRec, 'apa', 1);
const mwGb = rc.formatCitation(mwRec, 'gb', 1);
const mwIeee = rc.formatCitation(mwRec, 'ieee', 3);
const mwOk = mwApa.includes('Gomez, A. N.') && mwApa.includes('Vaswani, A.') && mwGb.includes('Gomez AN') && !mwIeee.includes(', ,');
if (!mwOk) offlineFail++;
console.log(`multi-word given ${mwOk ? 'OK ' : 'FAIL'} apa="${mwApa}"`);
console.log(`  gb="${mwGb}"`);
console.log(`  ieee="${mwIeee}"`);

// Title guesses per style
const titleCases = [
	['娣卞害娈嬪樊瀛︿範鐢ㄤ簬鍥惧儚璇嗗埆', '浣曟伜鏄? 寮犵ゥ闆? 浠诲皯鍗? 瀛欏墤. 娣卞害娈嬪樊瀛︿範鐢ㄤ簬鍥惧儚璇嗗埆[J]. 璁＄畻鏈哄鎶? 2016, 39(4): 771-785.'],
	['Attention is all you need', '[1] A. Vaswani, N. Shazeer, et al., "Attention is all you need," in NeurIPS, vol. 30, 2017.'],
	['Attention is all you need', "Vaswani, A. (2017) 'Attention is all you need'. NeurIPS, 30."],
	['Attention is all you need', 'Vaswani A, Shazeer N. Attention is all you need. NeurIPS. 2017;30:5998-6008.'],
	['Attention is all you need', 'Vaswani, A. A.; Shazeer, N. Attention is all you need. Neural Inf. Process. Syst. 2017, 30, 5998-6008.'],
	['Attention is all you need', 'Vaswani, A., Shazeer, N. (2017). Attention is all you need. NeurIPS, 30.'],
];
for (const [want, line] of titleCases) {
	const got = rc.guessTitleFromLine(line);
	const ok = got === want;
	if (!ok) offlineFail++;
	console.log(`title  ${ok ? 'OK ' : 'FAIL'} want="${want}" got="${got}"`);
}

// 鈹€鈹€ online: mixed-style input through the real tool 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const controller = new AbortController();
const result = await toolDef.execute(
	{
		references:
			'Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, 艁., & Polosukhin, I. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30.\n' +
			'VASWANI A, SHAZEE N, PARMAR N, USZKOREIT J, et al. Attention is all you need[J]. Advances in Neural Information Processing Systems, 2017, 30.\n' +
			'[1] A. Vaswani, N. Shazeer, N. Parmar, et al., "Attention is all you need," in Advances in Neural Information Processing Systems, vol. 30, 2017.\n' +
			'Vaswani, Ashish, Noam Shazeer, et al. 2017. "Attention Is All You Need." Advances in Neural Information Processing Systems 30.\n' +
			"Vaswani, A. (2017) 'Attention is all you need'. Advances in Neural Information Processing Systems, 30.\n" +
			'Vaswani A, Shazeer N, Parmar N, et al. Attention is all you need. Advances in Neural Information Processing Systems. 2017;30:5998-6008.\n' +
			'He, K. et al. (2016) Deep residual learning for image recognition. In CVPR.\n' +
			'Doe, J. (2099) Quantum Flux Capacitators in Wireless Batteries. Journal of Fake Science, 42(1), 1-99.\n',
	},
	{ signal: controller.signal }
);

console.log('\n=== canonical result (must match RESULT_SCHEMA) ===');
console.log(JSON.stringify(result, null, 2));
console.log('\n=== rendered report ===');
console.log(toolDef.output.render(null, result)[0].text);
console.log(offlineFail === 0 ? '\nOFFLINE CHECKS PASSED' : `\nOFFLINE FAILURES: ${offlineFail}`);

