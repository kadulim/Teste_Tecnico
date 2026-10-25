import { LoggerService } from "@nestjs/common";

export class JsonLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void { this.write("info", message, optionalParams); }
  error(message: unknown, ...optionalParams: unknown[]): void { this.write("error", message, optionalParams); }
  warn(message: unknown, ...optionalParams: unknown[]): void { this.write("warn", message, optionalParams); }
  debug(message: unknown, ...optionalParams: unknown[]): void { this.write("debug", message, optionalParams); }
  verbose(message: unknown, ...optionalParams: unknown[]): void { this.write("verbose", message, optionalParams); }
  fatal(message: unknown, ...optionalParams: unknown[]): void { this.write("fatal", message, optionalParams); }

  private write(level: string, message: unknown, optionalParams: unknown[]): void {
    const context = optionalParams.slice().reverse().find((value) => typeof value === "string");
    const trace = level === "error"
      ? optionalParams.find((value) => typeof value === "string" && value !== context)
      : undefined;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event: "nestjs_log",
      message: typeof message === "string" ? message : JSON.stringify(message),
      ...(typeof context === "string" ? { context } : {}),
      ...(typeof trace === "string" ? { trace } : {}),
    };
    const output = JSON.stringify(record);
    if (level === "error" || level === "fatal") console.error(output);
    else if (level === "warn") console.warn(output);
    else console.log(output);
  }
}
