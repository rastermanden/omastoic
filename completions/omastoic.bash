# bash completion for omastoic
# Installed to ~/.local/share/bash-completion/completions/omastoic by `omastoic setup`.

_omastoic() {
  local cur prev cmd
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"
  cmd="${COMP_WORDS[1]}"

  local commands="toggle next preview show config ui status version uninstall help"
  local authors="@AUTHORS@"

  if ((COMP_CWORD == 1)); then
    mapfile -t COMPREPLY < <(compgen -W "$commands" -- "$cur")
    return 0
  fi

  case "$cmd" in
  config | configure)
    if [[ $prev == --authors || $cur == *,* ]]; then
      local prefix="" last="$cur"
      if [[ $cur == *,* ]]; then
        prefix="${cur%,*},"
        last="${cur##*,}"
      fi
      local -a hits=()
      mapfile -t hits < <(compgen -W "$authors" -- "$last")
      COMPREPLY=("${hits[@]/#/${prefix}}")
      return 0
    fi
    if [[ $prev == --image ]]; then
      mapfile -t COMPREPLY < <(compgen -f -- "$cur")
      return 0
    fi
    if [[ $prev == --interval || $prev == --quotes || $prev == --add || $prev == --add-author || $prev == --replace-author || $prev == --remove-author || $prev == --name || $prev == --dates || $prev == --citation || $prev == --text ]]; then
      return 0
    fi
    mapfile -t COMPREPLY < <(compgen -W "--authors --interval --quotes --add --add-author --replace-author --remove-author --name --dates --image --citation --text --list --plain" -- "$cur")
    ;;
  uninstall)
    mapfile -t COMPREPLY < <(compgen -W "--purge" -- "$cur")
    ;;
  show)
    mapfile -t COMPREPLY < <(compgen -W "--cols --rows" -- "$cur")
    ;;
  status)
    mapfile -t COMPREPLY < <(compgen -W "--verbose -v" -- "$cur")
    ;;
  esac
}

complete -F _omastoic omastoic
