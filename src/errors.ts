/** 带用户可读话术的剪藏错误 */
export class ClipError extends Error {
  readonly userMessage: string;
  constructor(message: string, userMessage?: string) {
    super(message);
    this.name = "ClipError";
    this.userMessage = userMessage ?? message;
  }
}
