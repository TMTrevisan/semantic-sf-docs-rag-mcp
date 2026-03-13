import fs from 'fs';
import pdf from 'pdf-parse';
import path from 'path';

const pdfPath = process.argv[2];
if (!pdfPath) {
    console.error('Usage: node extract-pdf.js <path/to/pdf>');
    process.exit(1);
}

const outPath = pdfPath.replace('.pdf', '.md');

async function extractToMarkdown() {
    console.log(`Reading ${pdfPath}...`);
    const dataBuffer = fs.readFileSync(pdfPath);
    
    console.log('Parsing PDF (this may take a minute for 40MB)...');
    
    // Custom render page function to add some semantic structure
    const render_page = function(pageData) {
        let render_options = {
            normalizeWhitespace: false,
            disableCombineTextItems: false
        };
        
        return pageData.getTextContent(render_options)
        .then(function(textContent) {
            let lastY, text = '';
            for (let item of textContent.items) {
                // If there's a significant vertical gap, it's likely a new paragraph
                if (lastY != item.transform[5] && !text.endsWith('\n')) {
                    text += '\n';
                }
                
                // Very basic header detection based on font height
                if (item.height > 20) {
                    text += '\n## ' + item.str.trim() + '\n';
                } else if (item.height > 15) {
                    text += '\n### ' + item.str.trim() + '\n';
                } else {
                    text += item.str.trim() + ' ';
                }
                
                lastY = item.transform[5];
            }
            return text + '\n\n---\n*Page ' + pageData.pageIndex + '*\n\n';
        });
    };
    
    const options = {
        pagerender: render_page
    };
    
    const data = await pdf(dataBuffer, options);
    
    console.log(`Extracted ${data.numpages} pages.`);
    
    // Clean up the text a bit
    let mdText = data.text
        .replace(/\n{3,}/g, '\n\n') // Remove excessive empty lines
        .trim();
        
    mdText = `# ${path.basename(pdfPath, '.pdf')}\n\n` + mdText;
    
    fs.writeFileSync(outPath, mdText);
    console.log(`✅ Saved to ${outPath}`);
}

extractToMarkdown().catch(console.error);
