# fish completion for omastoic
complete -c omastoic -f
complete -c omastoic -n "__fish_use_subcommand" -a toggle -d "Hand the screensaver to the Stoics, or give it back"
complete -c omastoic -n "__fish_use_subcommand" -a preview -d "Write a new canvas and start the screensaver now"
complete -c omastoic -n "__fish_use_subcommand" -a config -d "Choose Stoics, which of their quotes, and seconds between quotes"
complete -c omastoic -n "__fish_use_subcommand" -a status -d "Who has the screensaver, and what is in the quote book"
complete -c omastoic -n "__fish_use_subcommand" -a uninstall -d "Take the service, menu row and plugin back out"
complete -c omastoic -n "__fish_use_subcommand" -a help -d "Show help"

complete -c omastoic -n "__fish_seen_subcommand_from config" -l authors -xa "@AUTHORS@" -d "Who appears"
complete -c omastoic -n "__fish_seen_subcommand_from config" -l interval -d "Seconds between quotes"
complete -c omastoic -n "__fish_seen_subcommand_from config" -l quotes -d "Bundled quotes: marcus=q01,q02, marcus=all, marcus=none, or all"
complete -c omastoic -n "__fish_seen_subcommand_from config" -l add -d "Append one tab-separated quote"
complete -c omastoic -n "__fish_seen_subcommand_from config" -l list -d "List bundled quote ids"
complete -c omastoic -n "__fish_seen_subcommand_from uninstall" -l purge -d "Also drop quotes and settings"
