function parseHexColor(value) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
    if (!match) return null;
    return {
        red: parseInt(match[1], 16),
        green: parseInt(match[2], 16),
        blue: parseInt(match[3], 16)
    };
}

function formatHexColor({ red, green, blue }) {
    const hex = value => Math.max(0, Math.min(255, Math.round(value)))
        .toString(16).padStart(2, '0');
    return `#${hex(red)}${hex(green)}${hex(blue)}`.toUpperCase();
}

if (typeof module !== 'undefined') module.exports = { formatHexColor, parseHexColor };
