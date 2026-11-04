# SQL Server Backup Automation

A Node.js script that automates SQL Server backups end to end: it creates the backup, compresses it, uploads it over FTP with automatic retries, and keeps only the most recent backups both locally and on the FTP server.

**Why it exists:** backing up several client servers meant logging into each one, running the backup by hand and sending the file, which cost time every day and often failed during the upload. This script replaced that manual routine with a scheduled, self-cleaning process that logs every step.

> Built to solve a real operational problem in a previous role. This public version contains no company or client data.

## What it does

1. Validates `config.json` and creates the backup and log folders if needed.
2. Runs `BACKUP DATABASE ... WITH CHECKSUM` on the configured database.
3. Compresses the `.bak` into a `.zip` (zlib level 9), checks the zip is not empty, then removes the `.bak`.
4. Keeps only the **2 most recent `.zip` files** in the local folder.
5. Uploads the zip to each configured FTP server (passive mode), **retrying up to 3 times**, and validates that the remote file size matches the local one.
6. Keeps only the **2 most recent backups on the FTP server** as well.
7. On any failure, writes an error log locally and uploads it to an `ERRO/` folder on the FTP server.
8. Writes a timestamped log file of every step.

## Tech

Node.js · `mssql` · `archiver` · `promise-ftp`

## Setup

```bash
npm install
cp config.example.json config.json     # then edit with your values
```

Set credentials as environment variables (never commit them):

| Variable | Purpose |
|---|---|
| `FTP_USER` | FTP username |
| `FTP_PASSWORD` | FTP password |
| `SQL_PASSWORD` | SQL Server password (optional; can also be set as `sqlPassword` in `config.json`) |

On Windows (PowerShell, machine-wide so a scheduled task can read them):

```powershell
[System.Environment]::SetEnvironmentVariable("FTP_USER", "your_user", "Machine")
[System.Environment]::SetEnvironmentVariable("FTP_PASSWORD", "your_password", "Machine")
```

## Run

```bash
npm run test-connection   # checks the SQL Server connection
npm start                 # runs the full backup
```

To run it daily, create a scheduled task, for example:

```bat
schtasks /create /tn "SQL Backup" /tr "node C:\path\to\backup.js" /sc daily /st 02:00
```

## Configuration (`config.json`)

| Field | Description |
|---|---|
| `databaseName` | Database to back up |
| `server` | SQL Server instance, e.g. `HOSTNAME\\SQLINSTANCE` |
| `authType` / `sqlUser` | SQL authentication |
| `backupFolder` | Local folder for backups (must be writable by the SQL Server service) |
| `logFile` | Path of the log file |
| `ftpServers` | List of `{ Host, Port }` entries |
| `remotePath` | Remote folder for the zip files |

## Notes and limitations

- Log messages and code comments are in Portuguese, the language of the original environment.
- FTP is used in plain mode (`secure: false`). For sensitive data, switch to FTPS or SFTP.
- Only SQL authentication is implemented.

## Author

Nivon Ingles dos Santos · [LinkedIn](https://www.linkedin.com/in/nivoningles) · [GitHub](https://github.com/nivoningles)
