const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const sql = require('mssql');
const archiver = require('archiver');
const PromiseFtp = require('promise-ftp');
const config = require('./config.json');

// Função para escrever no arquivo de log
async function writeLog(message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const logMessage = `${timestamp} - ${message}\n`;
    const logDir = path.dirname(config.logFile);

    try {
        await fsPromises.mkdir(logDir, { recursive: true });
    } catch (error) {
        console.error(`Erro ao criar diretório de log ${logDir}: ${error.message}`);
        throw error;
    }

    await fsPromises.appendFile(config.logFile, logMessage);
    console.log(message);
}

// Função para garantir que a pasta remota existe no FTP
async function ensureFtpDirectory(ftp, remotePath) {
    try {
        await ftp.list(remotePath);
        await writeLog(`Pasta remota ${remotePath} já existe.`);
    } catch (error) {
        if (error.code === 550 || error.message.includes('No such file or directory')) {
            await ftp.mkdir(remotePath, true);
            await writeLog(`Pasta remota ${remotePath} criada no FTP.`);
        } else {
            throw error;
        }
    }
}

// Função para enviar log de erro para o FTP com tentativas de reconexão
async function sendErrorLogToFTP(errorMessage) {
    const errorTimestamp = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14);
    const errorLogFile = path.join(config.backupFolder, `Erro_${config.databaseName}-${errorTimestamp}.log`);
    const errorLogRemote = `${config.remotePath}/ERRO/Erro_${config.databaseName}-${errorTimestamp}.log`;

    try {
        await fsPromises.mkdir(config.backupFolder, { recursive: true });
        await fsPromises.writeFile(errorLogFile, errorMessage, 'utf8');
        await writeLog(`Arquivo de erro criado localmente: ${errorLogFile}`);
    } catch (error) {
        await writeLog(`Erro ao salvar log de erro localmente: ${error.message}`);
        return;
    }

    const ftpUser = process.env.FTP_USER;
    const ftpPassword = process.env.FTP_PASSWORD;
    if (!ftpUser || !ftpPassword) {
        await writeLog('Erro: Variáveis de ambiente FTP_USER e FTP_PASSWORD não definidas! Continuando sem enviar log para FTP.');
        return;
    }

    for (const server of config.ftpServers) {
        const ftpServer = `${server.Host}:${server.Port}`;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                await writeLog(`Tentando enviar log de erro para FTP: ${ftpServer} (Tentativa ${attempts}/${maxAttempts})...`);

                const ftp = new PromiseFtp();
                await ftp.connect({
                    host: server.Host,
                    port: server.Port,
                    user: ftpUser,
                    password: ftpPassword,
                    passive: true,
                    secure: false,
                    connTimeout: 60000, // Aumentado para maior estabilidade
                    pasvTimeout: 60000
                });

                await ensureFtpDirectory(ftp, `${config.remotePath}/ERRO`);
                await ftp.put(errorLogFile, errorLogRemote);
                await writeLog(`Log de erro enviado com sucesso para ${ftpServer}!`);
                await ftp.end();
                return;
            } catch (error) {
                await writeLog(`Falha ao enviar log de erro para FTP ${ftpServer}: ${error.message}`);
                if (attempts < maxAttempts) {
                    await writeLog('Aguardando 2 segundos antes de tentar novamente...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
    }
    await writeLog('Falha ao enviar log de erro para todos os servidores FTP.');
}

// Função principal de backup
async function main() {
    // Validar configurações
    const requiredFields = ['databaseName', 'server', 'authType', 'backupFolder', 'logFile', 'ftpServers', 'remotePath'];
    for (const field of requiredFields) {
        if (!config[field] && config[field] !== '') {
            const errorMsg = `Campo obrigatório "${field}" não definido no config.json!`;
            await writeLog(errorMsg);
            throw new Error(errorMsg);
        }
    }

    if (config.ftpServers.length === 0) {
        const errorMsg = 'A lista de ftpServers está vazia no config.json!';
        await writeLog(errorMsg);
        throw new Error(errorMsg);
    }

    for (const server of config.ftpServers) {
        if (!server.Host || !server.Port) {
            const errorMsg = 'Cada servidor FTP deve ter Host e Port definidos no config.json!';
            await writeLog(errorMsg);
            throw new Error(errorMsg);
        }
    }

    if (config.authType === 'sql' && !config.sqlUser) {
        const errorMsg = 'Autenticação SQL selecionada, mas o usuário do SQL Server não foi definido no config.json!';
        await writeLog(errorMsg);
        throw new Error(errorMsg);
    }

    const serverInstance = config.server;
    await writeLog(`Iniciando backup do banco de dados: ${config.databaseName}`);

    // Criar pasta de backup se não existir
    try {
        await fsPromises.mkdir(config.backupFolder, { recursive: true });
        await writeLog(`Pasta de backup criada ou já existente: ${config.backupFolder}`);
    } catch (error) {
        const errorMsg = `Erro ao criar pasta de backup ${config.backupFolder}: ${error.message}`;
        await writeLog(errorMsg);
        throw new Error(errorMsg);
    }

    // Criar novo backup
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14);
    const backupFile = path.join(config.backupFolder, `${config.databaseName}-${timestamp}.bak`);
    const zipFile = path.join(config.backupFolder, `backup_${config.databaseName}-${timestamp}.zip`); // Unificado com prefixo backup_

    const sqlCommand = `
        BACKUP DATABASE [${config.databaseName}]
        TO DISK = '${backupFile}'
        WITH CHECKSUM, STATS = 10, INIT;
    `;

    let pool;
    try {
        await writeLog(`Conectando ao SQL Server ${serverInstance} usando autenticação ${config.authType}...`);

        pool = await sql.connect({
            server: serverInstance,
            database: config.databaseName,
            user: config.sqlUser,
            password: process.env.SQL_PASSWORD || config.sqlPassword,
            options: { trustServerCertificate: true }
        });

        await writeLog('Executando comando SQL de backup...');
        await pool.request().query(sqlCommand);
        await writeLog(`Backup criado com sucesso: ${backupFile}`);
    } catch (error) {
        const errorMsg = `Erro ao criar backup do banco de dados: ${error.message}. Verifique se o servidor ${config.server} está acessível e se o SQL Server Browser está ativo.`;
        await writeLog(errorMsg);
        await sendErrorLogToFTP(errorMsg);
        process.exit(1);
    } finally {
        if (pool) await pool.close();
    }

    // Compactar o arquivo de backup
    await writeLog('Compactando o arquivo de backup...');
    try {
        const output = fs.createWriteStream(zipFile);
        const archive = archiver('zip', { zlib: { level: 9 } });

        const outputClosed = new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
        });

        archive.pipe(output);
        archive.file(backupFile, { name: path.basename(backupFile) });
        await archive.finalize();
        await outputClosed;

        const stats = await fsPromises.stat(zipFile);
        if (stats.size === 0) {
            throw new Error('Arquivo zip criado está vazio!');
        }

        await writeLog(`Backup compactado com sucesso: ${zipFile}`);

        // Atraso para garantir que o arquivo .bak seja liberado
        await writeLog('Aguardando 5 segundos antes de excluir o arquivo .bak...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        await fsPromises.unlink(backupFile);
        await writeLog(`Arquivo .bak removido: ${backupFile}`);
    } catch (error) {
        const errorMsg = `Erro ao compactar o backup: ${error.message}`;
        await writeLog(errorMsg);
        await sendErrorLogToFTP(errorMsg);
        process.exit(1);
    }

    // Gerenciar backups antigos localmente (.bak e .zip)
    try {
        await writeLog('Verificando backups locais antigos...');

        // Deletar arquivos .bak antigos
        const bakFiles = (await fsPromises.readdir(config.backupFolder))
            .filter(file => file.match(new RegExp(`^${config.databaseName}-\\d{14}\\.bak$`)))
            .map(file => ({
                name: file,
                mtime: fs.statSync(path.join(config.backupFolder, file)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime);

        await writeLog(`Encontrados ${bakFiles.length} arquivos .bak locais: ${bakFiles.map(f => f.name).join(', ')}`);

        for (const file of bakFiles) {
            const filePath = path.join(config.backupFolder, file.name);
            try {
                await fsPromises.unlink(filePath);
                await writeLog(`Removido arquivo .bak antigo: ${file.name}`);
            } catch (deleteError) {
                await writeLog(`Erro ao remover arquivo .bak antigo ${file.name}: ${deleteError.message}`);
            }
        }

        // Manter no máximo 2 backups .zip
        const zipFiles = (await fsPromises.readdir(config.backupFolder))
            .filter(file => file.match(new RegExp(`^backup_${config.databaseName}-\\d{14}\\.zip$`))) // Atualizado para novo padrão
            .map(file => ({
                name: file,
                mtime: fs.statSync(path.join(config.backupFolder, file)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime);

        await writeLog(`Encontrados ${zipFiles.length} arquivos .zip locais: ${zipFiles.map(f => f.name).join(', ')}`);

        if (zipFiles.length > 2) {
            const filesToDelete = zipFiles.slice(2);
            for (const file of filesToDelete) {
                const filePath = path.join(config.backupFolder, file.name);
                try {
                    await fsPromises.unlink(filePath);
                    await writeLog(`Removido backup .zip antigo: ${file.name}`);
                } catch (deleteError) {
                    await writeLog(`Erro ao remover backup .zip antigo ${file.name}: ${deleteError.message}`);
                }
            }
        } else {
            await writeLog('Menos de 2 backups .zip locais encontrados, nenhum removido.');
        }
    } catch (error) {
        await writeLog(`Erro ao gerenciar backups locais antigos: ${error.message}`);
    }

    // Enviar backup para o FTP
    await writeLog('Iniciando o processo de envio do arquivo para o servidor FTP...');
    const ftpUser = process.env.FTP_USER;
    const ftpPassword = process.env.FTP_PASSWORD;
    if (!ftpUser || !ftpPassword) {
        await writeLog('Erro: Variáveis de ambiente FTP_USER e FTP_PASSWORD não definidas! Continuando sem enviar backup para FTP.');
    } else {
        for (const server of config.ftpServers) {
            const ftpServer = `${server.Host}:${server.Port}`;
            let ftp;
            let attempts = 0;
            const maxAttempts = 3;

            // Enviar arquivo
            while (attempts < maxAttempts) {
                attempts++;
                try {
                    await writeLog(`Tentando conectar ao FTP: ${ftpServer} (Tentativa ${attempts}/${maxAttempts})...`);

                    ftp = new PromiseFtp();
                    await ftp.connect({
                        host: server.Host,
                        port: server.Port,
                        user: ftpUser,
                        password: ftpPassword,
                        passive: true,
                        secure: false,
                        connTimeout: 60000, // Aumentado para maior estabilidade
                        pasvTimeout: 60000
                    });

                    await ensureFtpDirectory(ftp, config.remotePath);
                    const remoteFile = `${config.remotePath}/backup_${config.databaseName}-${timestamp}.zip`;
                    await writeLog(`Enviando arquivo para ${remoteFile}...`);
                    await ftp.put(zipFile, remoteFile);

                    // Validar tamanho do arquivo remoto (se suportado)
                    try {
                        const remoteSize = await ftp.size(remoteFile);
                        const localSize = (await fsPromises.stat(zipFile)).size;
                        if (remoteSize !== localSize) {
                            throw new Error(`Tamanho do arquivo remoto (${remoteSize}) não corresponde ao local (${localSize})`);
                        }
                    } catch (sizeError) {
                        await writeLog(`Erro ao validar tamanho do arquivo remoto: ${sizeError.message}`);
                        throw sizeError;
                    }

                    await writeLog(`Backup enviado com sucesso para ${ftpServer}!`);
                    break;
                } catch (error) {
                    await writeLog(`Erro ao tentar enviar o arquivo para ${ftpServer}: ${error.message}`);
                    if (attempts < maxAttempts) {
                        await writeLog('Aguardando 2 segundos antes de tentar novamente...');
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                } finally {
                    if (ftp && ftp.getConnectionStatus() !== 'disconnected') {
                        await ftp.end();
                    }
                }
            }

            // Limpar backups antigos no FTP
            attempts = 0;
            while (attempts < maxAttempts) {
                attempts++;
                try {
                    await writeLog(`Tentando limpar backups antigos no FTP: ${ftpServer} (Tentativa ${attempts}/${maxAttempts})...`);
                    ftp = new PromiseFtp();
                    await ftp.connect({
                        host: server.Host,
                        port: server.Port,
                        user: ftpUser,
                        password: ftpPassword,
                        passive: true,
                        secure: false,
                        connTimeout: 60000,
                        pasvTimeout: 60000
                    });

                    await ensureFtpDirectory(ftp, config.remotePath);
                    let remoteFiles = (await ftp.list(config.remotePath))
                        .filter(file => file.name.match(new RegExp(`^backup_${config.databaseName}-\\d{14}\\.zip$`)))
                        .map(file => ({
                            name: file.name,
                            mtime: file.date ? new Date(file.date) : new Date(0) // Fallback para data inválida
                        }))
                        .filter(file => !isNaN(file.mtime.getTime())) // Ignorar datas inválidas
                        .sort((a, b) => b.mtime - a.mtime);

                    await writeLog(`Encontrados ${remoteFiles.length} backups remotos: ${remoteFiles.map(f => f.name).join(', ')}`);

                    if (remoteFiles.length > 2) {
                        const filesToDelete = remoteFiles.slice(2);
                        for (const file of filesToDelete) {
                            const filePath = `${config.remotePath}/${file.name}`;
                            try {
                                await ftp.delete(filePath);
                                await writeLog(`Removido backup remoto antigo: ${file.name}`);
                            } catch (deleteError) {
                                await writeLog(`Erro ao remover backup remoto ${file.name}: ${deleteError.message}`);
                            }
                        }
                    } else {
                        await writeLog('Menos de 2 backups remotos encontrados, nenhum removido.');
                    }

                    break;
                } catch (error) {
                    await writeLog(`Erro ao limpar backups antigos no FTP ${ftpServer}: ${error.message}`);
                    if (attempts < maxAttempts) {
                        await writeLog('Aguardando 2 segundos antes de tentar novamente...');
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                } finally {
                    if (ftp && ftp.getConnectionStatus() !== 'disconnected') {
                        await ftp.end();
                    }
                }
            }
        }
        await writeLog('Processo de envio e limpeza do FTP concluído.');
    }

    await writeLog('Processo de backup concluído com sucesso!');
}

// Executar a função principal
main().catch(async error => {
    await writeLog(`Erro fatal: ${error.message}`);
    process.exit(1);
});