import {fetchTrial, fetchTrials} from './api.js';
import {logger} from './logging.js';

try {
    const results = await fetchTrials();

    const data = await Promise.all(
        results.hits.map(hit => fetchTrial(hit.id, {history: true}))
    );

} catch (err) {
    logger.error(`Error: ${err.message}`);
}
