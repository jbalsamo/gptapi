import winston from 'winston';
import { format } from 'winston';
const { combine, timestamp, printf, colorize } = format;
// Custom format for log messages
const myFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level}]: ${message}`;
});
// Configure the logger
const appLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), colorize(), myFormat),
    transports: [
        // Write all logs to console
        new winston.transports.Console(),
        // Write all logs with level 'error' and below to 'error.log'
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            dirname: 'logs'
        }),
        // Write all logs to 'combined.log'
        new winston.transports.File({
            filename: 'logs/combined.log',
            dirname: 'logs'
        })
    ]
});
// If we're not in production, log to the console with more detailed formatting
if (process.env.NODE_ENV !== 'production') {
    appLogger.add(new winston.transports.Console({
        format: combine(colorize(), timestamp(), printf(info => `${info.timestamp} ${info.level}: ${info.message}`))
    }));
}
export { appLogger };
