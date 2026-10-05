import {parentPort, workerData} from 'node:worker_threads';
import {listSessions, loadSession} from './session';
import {prepareResume} from './resume-preparation';

function readResume() {
	const {ref, maxMessages} = workerData.resume;
	let session = workerData.resume.session;
	if (!session) {
		// Explicit ids do not scan every saved transcript first.
		const id =
			ref === 'last' || /^\d+$/.test(ref)
				? listSessions()[ref === 'last' ? 0 : Number(ref)]?.id
				: ref;
		session = id ? loadSession(id) : null;
	}
	return session ? prepareResume(session, maxMessages) : null;
}

parentPort!.postMessage(
	workerData?.resume
		? readResume()
		: workerData?.id
			? loadSession(workerData.id)
			: listSessions(),
);
