import {
  AccessLevel,
  SingletonProto,
  Inject,
} from '@eggjs/tegg';
import { NFSAdapter } from '../../common/adapter/NFSAdapter';
import { TaskState, TaskType } from '../../common/enum/Task';
import { AbstractService } from '../../common/AbstractService';
import { TaskRepository } from '../../repository/TaskRepository';
import { Task, CreateSyncPackageTaskData } from '../entity/Task';
import { QueueAdapter } from '../../common/typing';

@SingletonProto({
  accessLevel: AccessLevel.PUBLIC,
})
export class TaskService extends AbstractService {
  @Inject()
  private readonly taskRepository: TaskRepository;
  @Inject()
  private readonly nfsAdapter: NFSAdapter;
  @Inject()
  private readonly queueAdapter: QueueAdapter;

  public async getTaskQueueLength(taskType: TaskType) {
    return await this.queueAdapter.length(taskType);
  }

  public async createTask(task: Task, addTaskQueueOnExists: boolean) {
    const existsTask = await this.taskRepository.findTaskByTargetName(task.targetName, task.type);
    // 默认跳过同名依赖的同步
    let haveTheSameVersionTask = true;
    if (task.type === TaskType.SyncPackage) {
      const currentSpecificVersion = (task as Task<CreateSyncPackageTaskData>)?.data?.specificVersion;
      if (currentSpecificVersion) {
        const existsTaskVersionList = await this.taskRepository.findAllTaskVersionByTargetName(task.targetName, task.type);
        if (currentSpecificVersion && !existsTaskVersionList.includes(currentSpecificVersion)) {
          // 仅当指定了同步版本且同步版本不在当前任务列表中时不当作existsTask
          haveTheSameVersionTask = false;
        }
      }
    }
    if (existsTask && haveTheSameVersionTask) {
      // 如果任务还未被触发，并且是相同版本的同步任务，就不继续重复创建
      // 如果任务正在执行，可能任务状态已更新，这种情况需要继续创建
      if (existsTask.state === TaskState.Waiting) {
        // 提高任务的优先级
        if (addTaskQueueOnExists) {
          const queueLength = await this.getTaskQueueLength(task.type);
          if (queueLength < this.config.cnpmcore.taskQueueHighWaterSize) {
            // make sure waiting task in queue
            await this.queueAdapter.push<string>(task.type, existsTask.taskId);
            this.logger.info('[TaskService.createTask:exists-to-queue] taskType: %s, targetName: %s, taskId: %s, queue size: %s',
              task.type, task.targetName, task.taskId, queueLength);
          }
        }
      }
      return existsTask;
    }
    await this.taskRepository.saveTask(task);
    await this.queueAdapter.push<string>(task.type, task.taskId);
    const queueLength = await this.getTaskQueueLength(task.type);
    this.logger.info('[TaskService.createTask:new] taskType: %s, targetName: %s, taskId: %s, queue size: %s',
      task.type, task.targetName, task.taskId, queueLength);
    return task;
  }

  public async retryTask(task: Task, appendLog?: string) {
    if (appendLog) {
      await this.appendLogToNFS(task, appendLog);
    }
    task.state = TaskState.Waiting;
    await this.taskRepository.saveTask(task);
    await this.queueAdapter.push<string>(task.type, task.taskId);
    const queueLength = await this.getTaskQueueLength(task.type);
    this.logger.info('[TaskService.retryTask:save] taskType: %s, targetName: %s, taskId: %s, queue size: %s',
      task.type, task.targetName, task.taskId, queueLength);
  }

  public async findTask(taskId: string) {
    return await this.taskRepository.findTask(taskId);
  }

  public async findTasks(taskIdList: Array<string>) {
    return await this.taskRepository.findTasks(taskIdList);
  }

  public async findTaskLog(task: Task) {
    return await this.nfsAdapter.getDownloadUrlOrStream(task.logPath);
  }

  public async findExecuteTask(taskType: TaskType) {
    let taskId = await this.queueAdapter.pop<string>(taskType);
    let task: Task | null;

    while (taskId) {
      task = await this.taskRepository.findTask(taskId);

      // 任务已删除或任务已执行
      // 继续取下一个任务
      if (task === null || task?.state !== TaskState.Waiting) {
        taskId = await this.queueAdapter.pop<string>(taskType);
        continue;
      }

      const condition = task.start();
      const saveSucceed = await this.taskRepository.idempotentSaveTask(task, condition);
      if (!saveSucceed) {
        taskId = await this.queueAdapter.pop<string>(taskType);
        continue;
      }
      return task;
    }

    return null;
  }

  public async retryExecuteTimeoutTasks() {
    // try processing timeout tasks in 10 mins
    const tasks = await this.taskRepository.findTimeoutTasks(TaskState.Processing, 60000 * 10);
    for (const task of tasks) {
      // ignore ChangesStream task, it won't timeout
      if (task.attempts >= 3 && task.type !== TaskType.ChangesStream) {
        await this.finishTask(task, TaskState.Timeout);
        this.logger.warn(
          '[TaskService.retryExecuteTimeoutTasks:timeout] taskType: %s, targetName: %s, taskId: %s, attempts %s set to fail',
          task.type, task.targetName, task.taskId, task.attempts);
        continue;
      }
      if (task.attempts >= 1) {
        // reset logPath
        task.resetLogPath();
      }
      await this.retryTask(task);
      this.logger.info(
        '[TaskService.retryExecuteTimeoutTasks:retry] taskType: %s, targetName: %s, taskId: %s, attempts %s will retry again',
        task.type, task.targetName, task.taskId, task.attempts);
    }
    // try waiting timeout tasks in 30 mins
    const waitingTasks = await this.taskRepository.findTimeoutTasks(TaskState.Waiting, 60000 * 30);
    for (const task of waitingTasks) {
      await this.retryTask(task);
      this.logger.warn(
        '[TaskService.retryExecuteTimeoutTasks:retryWaiting] taskType: %s, targetName: %s, taskId: %s waiting too long',
        task.type, task.targetName, task.taskId);
    }
    return {
      processing: tasks.length,
      waiting: waitingTasks.length,
    };
  }

  public async appendTaskLog(task: Task, appendLog: string) {
    await this.appendLogToNFS(task, appendLog);
    await this.taskRepository.saveTask(task);
  }

  public async finishTask(task: Task, taskState: TaskState, appendLog?: string) {
    if (appendLog) {
      await this.appendLogToNFS(task, appendLog);
    }
    task.state = taskState;
    await this.taskRepository.saveTaskToHistory(task);
  }

  private async appendLogToNFS(task: Task, appendLog: string) {
    try {
      const nextPosition = await this.nfsAdapter.appendBytes(
        task.logPath,
        Buffer.from(appendLog + '\n'),
        task.logStorePosition,
        {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      );
      if (nextPosition) {
        task.logStorePosition = nextPosition;
      }
    } catch (err: any) {
      // [PositionNotEqualToLengthError]: Position is not equal to file length, status: 409
      // [ObjectNotAppendableError]: The object is not appendable
      if (err.code === 'PositionNotEqualToLength' || err.code === 'ObjectNotAppendable') {
        // override exists log file
        await this.nfsAdapter.uploadBytes(
          task.logPath,
          Buffer.from(appendLog + '\n'),
        );
        return;
      }
      throw err;
    }
  }
}
