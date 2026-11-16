import { MemoryRemote } from './memoryRemote';
import { describeRemoteContract } from './remoteContract';

describeRemoteContract('メモリ上の偽物', () => new MemoryRemote());
