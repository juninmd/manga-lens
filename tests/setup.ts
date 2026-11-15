// Carregado antes de todo arquivo de teste (bunfig.toml). O recuo de retry do
// httpFetch e' de producao; aqui ele so' fazia a suite dormir ~15 s sem testar nada.
process.env['HTTP_BACKOFF_MS'] ??= '0';
