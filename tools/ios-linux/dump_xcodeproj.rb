# Dumps the parts of an Xcode project that the Linux build needs as JSON:
# per-target build settings (project level, xcconfig, target level), source
# files with their per-file compiler flags, resources, script phases and
# dependencies. build.py turns this into clang/lld invocations.
#
# Usage: ruby dump_xcodeproj.rb <Project.xcodeproj> <Configuration> <out.json>

require 'json'
require 'xcodeproj'

project_path, configuration, out_path = ARGV
abort 'usage: dump_xcodeproj.rb <Project.xcodeproj> <Configuration> <out.json>' unless out_path

project = Xcodeproj::Project.open(project_path)

def real(ref)
  ref.real_path.to_s
rescue StandardError
  nil
end

def config_dump(config_list, configuration)
  config = config_list.build_configurations.find { |c| c.name == configuration }
  return { 'settings' => {}, 'xcconfig_path' => nil, 'xcconfig' => {} } unless config
  xcconfig_path = config.base_configuration_reference && real(config.base_configuration_reference)
  xcconfig = {}
  if xcconfig_path && File.exist?(xcconfig_path)
    xcconfig = Xcodeproj::Config.new(xcconfig_path).to_hash
  end
  { 'settings' => config.build_settings, 'xcconfig_path' => xcconfig_path, 'xcconfig' => xcconfig }
end

def phase_files(phase)
  return [] unless phase
  phase.files.map do |build_file|
    ref = build_file.file_ref
    next nil unless ref
    entry = { 'path' => real(ref), 'settings' => build_file.settings || {} }
    entry['name'] = ref.display_name if ref.respond_to?(:display_name)
    entry['source_tree'] = ref.source_tree if ref.respond_to?(:source_tree)
    entry['raw_path'] = ref.path if ref.respond_to?(:path)
    if ref.is_a?(Xcodeproj::Project::Object::PBXVariantGroup)
      entry['variants'] = ref.children.map { |child| real(child) }
    end
    entry
  end.compact
end

targets = project.targets.map do |target|
  entry = {
    'name' => target.name,
    'isa' => target.isa,
    'dependencies' => target.dependencies.map { |d| d.target ? d.target.name : d.name }.compact,
    'config' => config_dump(target.build_configuration_list, configuration),
  }
  if target.respond_to?(:shell_script_build_phases)
    entry['script_phases'] = target.shell_script_build_phases.map do |phase|
      {
        'name' => phase.name,
        'script' => phase.shell_script,
        'shell_path' => phase.shell_path,
        'input_paths' => phase.input_paths,
        'output_paths' => phase.output_paths,
        'input_file_list_paths' => phase.input_file_list_paths,
        'output_file_list_paths' => phase.output_file_list_paths,
      }
    end
  end
  if target.respond_to?(:product_type)
    entry['product_type'] = target.product_type
    entry['product_name'] = target.product_name
    entry['product_reference'] = target.product_reference && target.product_reference.path
    entry['sources'] = phase_files(target.source_build_phase)
    entry['resources'] = phase_files(target.resources_build_phase)
    entry['frameworks'] = phase_files(target.frameworks_build_phase)
    entry['headers'] = target.headers_build_phase.files.map do |build_file|
      next nil unless build_file.file_ref
      attributes = (build_file.settings || {})['ATTRIBUTES'] || []
      visibility = attributes.include?('Public') ? 'public' : (attributes.include?('Private') ? 'private' : 'project')
      { 'path' => real(build_file.file_ref), 'visibility' => visibility }
    end.compact
    if target.respond_to?(:file_system_synchronized_groups)
      entry['synchronized_groups'] = (target.file_system_synchronized_groups || []).map do |group|
        exceptions = []
        if group.respond_to?(:exceptions)
          (group.exceptions || []).each do |exception|
            next unless exception.respond_to?(:membership_exceptions)
            owner = exception.respond_to?(:target) && exception.target ? exception.target.name : nil
            next if owner && owner != target.name
            exceptions.concat(exception.membership_exceptions || [])
          end
        end
        { 'path' => group.path, 'source_tree' => group.source_tree, 'membership_exceptions' => exceptions }
      end
    end
  end
  entry
end

result = {
  'project_path' => File.expand_path(project_path),
  'project_dir' => File.dirname(File.expand_path(project_path)),
  'configuration' => configuration,
  'object_version' => project.object_version,
  'project_config' => config_dump(project.build_configuration_list, configuration),
  'targets' => targets,
}

File.write(out_path, JSON.pretty_generate(result))
