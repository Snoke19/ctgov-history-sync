import {fetchTrial} from './api.js';
import {logger} from './logging.js';

try {
    const data = await fetchTrial('NCT07697053', {history: true});

    logger.info(`Changes: ${data?.history?.changes?.length}`);

} catch (err) {
    logger.error(`Error: ${err.message}`);
}
