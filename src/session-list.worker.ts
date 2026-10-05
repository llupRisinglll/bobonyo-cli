import {parentPort, workerData} from 'node:worker_threads';
import {listSessions, loadSession} from './session';

parentPort!.postMessage(
	workerData?.id ? loadSession(workerData.id) : listSessions(),
);
