export function cleanParams(params = {}) {
    const result = {};

    for (const [key, rawValue] of Object.entries(params)) {
        let value = rawValue;

        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            value = value.join(',');
        }

        if (typeof value === 'string') {
            value = value.trim();
            if (value.length === 0) continue;
        }

        if (value === null || value === undefined) continue;

        result[key] = value;
    }

    return result;
}
