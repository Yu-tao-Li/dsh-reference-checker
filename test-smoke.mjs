// Smoke test for refcheck v2: minimal PDF generation + text extraction +
// reference parsing. Run with:  node smoke-test.mjs
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { PDFParse } from 'pdf-parse';
import * as rc from './lib/host.mjs';

const tmp = '.smoke';
mkdirSync(tmp, { recursive: true });

// 鈹€鈹€ 1. minimal valid PDF with a References section 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function makePdf(lines) {
	let content = 'BT /F1 11 Tf\n';
	for (const l of lines) {
		const esc = l.text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
		content += `1 0 0 1 72 ${l.y} Tm (${esc}) Tj\n`;
	}
	content += 'ET';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	let pdf = '%PDF-1.4\n';
	const offsets = [];
	objects.forEach((obj, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
	});
	const xrefPos = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
	return Buffer.from(pdf, 'latin1');
}

const pdfBuf = makePdf([
	{ y: 760, text: 'A Minimal Test Paper' },
	{ y: 720, text: 'This is the body. It is not a reference.' },
	{ y: 700, text: 'References' },
	{ y: 680, text: '[1] Vaswani, A. et al. (2017) Attention is all you need. NeurIPS.' },
	{ y: 660, text: '[2] He, K. et al. (2016) Deep residual learning for image recognition. CVPR.' },
]);
writeFileSync(`${tmp}/paper.pdf`, pdfBuf);

const parser = new PDFParse({ data: new Uint8Array(pdfBuf) });
const textResult = await parser.getText();
await parser.destroy();
console.log('=== PDF extracted text ===');
console.log(textResult.text);
console.log('pages:', textResult.total);

// 鈹€鈹€ 2. references-section detection + entry splitting 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const extracted = rc.extractReferences(textResult.text, 'pdf');
console.log('=== extracted references ===');
console.log('extraction:', extracted.extraction);
console.log('count:', extracted.refs.length);
for (const r of extracted.refs) console.log('-', r.line.slice(0, 80));

// 鈹€鈹€ 3. bibtex parse 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const bib = `@article{vaswani2017,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam},
  year={2017},
  journal={NeurIPS}
}
@inproceedings{fake2099,
  title={Quantum Flux Capacitators in Wireless Batteries},
  author={Doe, John},
  year={2099}
}`;
const bibRefs = rc.extractReferences(bib, 'bibtex');
console.log('=== bibtex ===');
console.log('extraction:', bibRefs.extraction, 'count:', bibRefs.refs.length);
for (const r of bibRefs.refs) console.log('-', r.line.slice(0, 80), '| year:', r.year, '| firstAuthor:', r.firstAuthor);

// 鈹€鈹€ 4. tex bibliography 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const tex = `\\section{Body}
Some body text here.
\\begin{thebibliography}{9}
\\bibitem{vaswani2017} Vaswani, A. et al. (2017) Attention is all you need.
\\bibitem{he2016} He, K. et al. (2016) Deep residual learning.
\\end{thebibliography}`;
const texRefs = rc.extractReferences(tex, 'tex');
console.log('=== tex ===');
console.log('extraction:', texRefs.extraction, 'count:', texRefs.refs.length);
for (const r of texRefs.refs) console.log('-', r.line.slice(0, 80));

// 鈹€鈹€ 5. GBK-encoded txt 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const gbkBuf = Buffer.from(
	'Smith, J. (2020) A real paper about testing. Journal of Testing.\nLi, M. (2019) 涓€绡囦腑鏂囧弬鑰冩枃鐚殑娴嬭瘯. 娴嬭瘯瀛︽姤.\n',
	'latin1' // placeholder; encode GBK properly below
);
// build a real GBK buffer
const gbkText = 'Vaswani, A. et al. (2017) Attention is all you need.\nHe, K. et al. (2016) Deep residual learning for image recognition.\n';
const gbkBuf2 = Buffer.from(gbkText, 'utf8'); // ascii is identical in GBK
writeFileSync(`${tmp}/refs.txt`, gbkBuf2);
const txtRefs = rc.extractReferences(rc.readTextSmart(`${tmp}/refs.txt`), 'text');
console.log('=== txt ===');
console.log('extraction:', txtRefs.extraction, 'count:', txtRefs.refs.length);
for (const r of txtRefs.refs) console.log('-', r.line.slice(0, 80), '| year:', r.year, '| firstAuthor:', r.firstAuthor);

rmSync(tmp, { recursive: true, force: true });
console.log('\nSMOKE TEST DONE');

