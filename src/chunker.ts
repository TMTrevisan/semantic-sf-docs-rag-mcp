export interface TextChunk {
    text: string;
}

export function chunkMarkdown(markdown: string, maxChunkLength: number = 800, overlap: number = 100): TextChunk[] {
    const chunks: TextChunk[] = [];
    const paragraphs = markdown.split(/\n\n+/);

    let currentChunk = "";

    for (const para of paragraphs) {
        let parts = [para];
        if (para.length > maxChunkLength) {
            parts = para.split(/\n/);
        }

        for (const part of parts) {
            if (currentChunk.length + part.length + 2 > maxChunkLength && currentChunk.length > 0) {
                chunks.push({ text: currentChunk.trim() });
                currentChunk = currentChunk.slice(-overlap) + "\n\n" + part;
            } else {
                currentChunk += (currentChunk ? "\n\n" : "") + part;
            }
        }
    }

    if (currentChunk.trim().length > 0) {
        chunks.push({ text: currentChunk.trim() });
    }

    return chunks;
}
