import {ConfigurationError} from "../error/errors.js";

export function assertPositiveInt(value: number, name: string) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new ConfigurationError(`${name} must be a positive integer.`);
    }
}