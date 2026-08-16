"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeText = normalizeText;
exports.fuzzyContains = fuzzyContains;
exports.matchWords = matchWords;
function normalizeText(value) {
    return Array.from(value.normalize("NFKC").toLowerCase())
        .filter((char) => /[\p{L}\p{N}]/u.test(char))
        .join("");
}
function levenshtein(left, right) {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    let current = new Array(right.length + 1);
    for (let row = 1; row <= left.length; row++) {
        current[0] = row;
        for (let column = 1; column <= right.length; column++) {
            const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
            current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + substitution);
        }
        [previous, current] = [current, previous];
    }
    return previous[right.length];
}
function fuzzyContains(text, target, score = 85) {
    const source = normalizeText(text);
    const needle = normalizeText(target);
    if (!source || !needle)
        return false;
    if (source.includes(needle))
        return true;
    const minSize = Math.max(1, needle.length - 1);
    const maxSize = Math.min(source.length, needle.length + 2);
    for (let size = minSize; size <= maxSize; size++) {
        for (let start = 0; start <= source.length - size; start++) {
            const part = source.slice(start, start + size);
            const similarity = Math.round((1 - levenshtein(needle, part) / Math.max(needle.length, part.length)) * 100);
            if (similarity >= score)
                return true;
        }
    }
    return false;
}
function matchWords(words, text, score = 85) {
    const hits = [];
    const missing = [];
    for (const word of words) {
        (fuzzyContains(text, word, score) ? hits : missing).push(word);
    }
    return { hits, missing };
}
//# sourceMappingURL=text-matcher.js.map