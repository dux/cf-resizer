require "yaml"

module CfResizer
  @domain = nil

  def self.domain
    return @domain if @domain

    dir = Dir.pwd
    loop do
      path = File.join(dir, ".cf-resizer.yaml")
      if File.exist?(path)
        config = YAML.safe_load(File.read(path))
        @domain = config["domain"] if config["domain"]
        break
      end
      parent = File.dirname(dir)
      break if parent == dir
      dir = parent
    end

    @domain ||= ENV["CF_DOMAIN"] || "localhost"
  end

  def self.url(sha1, domain: self.domain, **opts)
    transforms = []
    transforms << "c#{opts[:c]}" if opts[:c]
    transforms << "w#{opts[:w]}" if opts[:w]
    transforms << "h#{opts[:h]}" if opts[:h]
    transforms << "q#{opts[:q]}" if opts[:q]

    base = "https://#{domain}"
    return "#{base}/#{sha1}" if transforms.empty?
    "#{base}/r/#{transforms.join}/#{sha1}"
  end
end

# convenience method
def cf_resize_url(sha1, **opts)
  CfResizer.url(sha1, **opts)
end
