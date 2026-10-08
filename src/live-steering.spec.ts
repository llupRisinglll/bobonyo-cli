import {expect, test} from 'bun:test';
import {
	acknowledgeSteering,
	deliverSteering,
	type SteeringMessage,
} from './live-steering';

test('identical submissions have separate identities; snapshots preserve burst order', async () => {
	const first = {id: '1', value: 'same', attachments: {'1': '/saved.png'}};
	const second = {id: '2', value: 'same'};
	const later = {id: '3', value: 'later'};
	let inbox: SteeringMessage[] = [first, second];
	const delivered: SteeringMessage[] = [];
	await deliverSteering(
		inbox,
		async item => {
			if (item.id === first.id) inbox = [...inbox, later];
			await Promise.resolve();
			delivered.push(item);
			return true;
		},
		id => {
			inbox = acknowledgeSteering(inbox, id);
		},
	);
	expect(delivered).toEqual([first, second]);
	expect(inbox).toEqual([later]);
});

test('failed or interrupted preparation retains the direction and later arrivals', async () => {
	const inbox = [
		{id: '1', value: 'first'},
		{id: '2', value: 'second'},
	];
	const acknowledged: string[] = [];
	await deliverSteering(
		inbox,
		async () => false,
		id => acknowledged.push(id),
	);
	expect(acknowledged).toEqual([]);
	await expect(
		deliverSteering(
			inbox,
			async () => {
				throw new Error('preparation failed');
			},
			id => acknowledged.push(id),
		),
	).rejects.toThrow('preparation failed');
	expect(acknowledged).toEqual([]);
});
